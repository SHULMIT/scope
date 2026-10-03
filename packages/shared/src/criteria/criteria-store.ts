// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection } from 'mongodb';
import { CriteriaConfig, CriteriaDocument, GateId } from '../types/types.js';
import { DependencyGraph } from '../graph/dependency-graph.js';
import { gatesSatisfyInvariant } from '../gates/gates.js';
import {
  CriteriaDuplicateError,
  CriteriaHasDependentsError,
  CriteriaNotFoundError,
  CriteriaValidationError,
} from './criteria-errors.js';

/**
 * MongoDB-backed criteria store for CRUD operations on criteria definitions.
 *
 * Replaces filesystem-based criteria loading for multi-instance deployments.
 * Criteria documents are soft-deleted (deletedAt) rather than removed.
 */
export class CriteriaStore {
  constructor(
    private collection: Collection<CriteriaDocument>,
    /**
     * Project scope for every read/write. When set, all lookups, uniqueness
     * checks and DAG traversals are confined to this project so the same human
     * `id` can exist independently in different projects. When omitted the store
     * operates globally (legacy behaviour, used by unscoped callers/tests).
     */
    private projectId?: string,
  ) {}

  /** Merge the active project scope into a Mongo filter (no-op when unscoped). */
  private scoped(filter: Record<string, unknown>): Record<string, unknown> {
    return this.projectId ? { projectId: this.projectId, ...filter } : filter;
  }

  /** List all active (non-deleted) criteria */
  async getAll(): Promise<CriteriaDocument[]> {
    // NOTE: `.sort({ id: 1 })` is an ORDER BY that Cosmos DB (RU-based) can only
    // serve from a *range* index on the sort path. The unique `{ id: 1 }` index
    // (migration 002) is a uniqueness constraint, NOT a range index, so it does
    // not satisfy this sort — the compound `{ deletedAt: 1, id: 1 }` index
    // (migration 024) does. Without that index Cosmos returns a 400
    // "index path ... is excluded" (see #1192 / #1103), which is why creating or
    // updating a criterion with dependencies (both call validateNoCycles() ->
    // getAll()) failed on int/prod but not against local Azurite/Mongo.
    return this.collection
      .find(this.scoped({ deletedAt: { $exists: false } }))
      .sort({ id: 1 })
      .toArray();
  }

  /** Get a single criterion by ID */
  async get(id: string): Promise<CriteriaDocument | null> {
    return this.collection.findOne(this.scoped({ id, deletedAt: { $exists: false } }));
  }

  /** Create a new criterion. Validates uniqueness and dependency references. */
  async create(input: {
    projectId: string;
    id: string;
    prompt: string;
    dependsOn?: string[];
    gates?: GateId[];
  }): Promise<CriteriaDocument> {
    const { projectId: inputProjectId, id, prompt, dependsOn = [], gates } = input;

    // Guard against scope confusion: the uniqueness/dedup checks below run
    // through `scoped()` (i.e. against `this.projectId`), but the row is written
    // with the project id resolved here. If a caller ever constructs the store
    // scoped to project A yet passes `input.projectId = B`, the dedup would run
    // in A while the row lands in B — a silent cross-project write. Refuse only
    // when both are present and disagree; a scoped store may fill in an omitted
    // input, and an unscoped store (legacy/tests) defers entirely to the input.
    if (
      this.projectId !== undefined &&
      inputProjectId !== undefined &&
      this.projectId !== inputProjectId
    ) {
      throw new CriteriaValidationError(
        `projectId mismatch: store is scoped to '${this.projectId}' but create() was given '${inputProjectId}'`,
      );
    }
    // Write with the same scope the uniqueness check used, so the check and the
    // insert can never target different projects.
    const projectId = this.projectId ?? inputProjectId;

    // Validate ID format
    if (!/^[a-z][a-z0-9_]*$/.test(id)) {
      throw new CriteriaValidationError(
        `Invalid criteria ID '${id}'. Must match [a-z][a-z0-9_]*`
      );
    }

    // Check for duplicates among *active* criteria — scoped to this project so
    // the same id can exist in another project without a cross-project 409.
    const existing = await this.collection.findOne(this.scoped({ id, deletedAt: { $exists: false } }));
    if (existing) {
      throw new CriteriaDuplicateError(`Criteria '${id}' already exists`);
    }

    // A soft-deleted criterion in *this project* may still hold this id. With a
    // per-project unique index a plain insert would collide (E11000); detect the
    // tombstone and revive it instead of failing.
    const softDeleted = await this.collection.findOne(this.scoped({ id, deletedAt: { $exists: true } }));

    // Validate dependency references exist
    if (dependsOn.length > 0) {
      await this.validateDependencies(dependsOn);
    }

    // Validate no cycles would be introduced
    if (dependsOn.length > 0) {
      await this.validateNoCycles(id, dependsOn);
    }

    // Validate the downward-closed gate-compatibility invariant.
    await this.validateGateCompatibility(id, dependsOn, gates);

    const doc: CriteriaDocument = {
      projectId,
      id,
      prompt: prompt.trim(),
      dependsOn,
      ...(gates !== undefined && { gates }),
      createdAt: new Date(),
    };

    try {
      if (softDeleted) {
        // Overwrite the tombstone in place: install the new content and clear
        // the soft-delete marker (and any stale updatedAt) so the revived
        // criterion is indistinguishable from a brand-new one.
        await this.collection.updateOne(
          this.scoped({ id, deletedAt: { $exists: true } }),
          {
            $set: { ...doc },
            $unset: { deletedAt: '', updatedAt: '' },
          }
        );
      } else {
        await this.collection.insertOne(doc as any);
      }
    } catch (err) {
      // Safety net: any residual unique-index collision (e.g. a concurrent
      // create racing in) surfaces as a clean 409 rather than an opaque 500.
      if (this.isDuplicateKeyError(err)) {
        throw new CriteriaDuplicateError(`Criteria '${id}' already exists`);
      }
      throw err;
    }
    return doc;
  }

  /** True for a MongoDB duplicate-key error (E11000). */
  private isDuplicateKeyError(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: number }).code === 11000
    );
  }

  /** Update a criterion's prompt, dependencies and/or gate compatibility */
  async update(
    id: string,
    patch: { prompt?: string; dependsOn?: string[]; gates?: GateId[] }
  ): Promise<CriteriaDocument> {
    const existing = await this.get(id);
    if (!existing) {
      throw new CriteriaNotFoundError(`Criteria '${id}' not found`);
    }

    // Validate dependencies if changing them
    if (patch.dependsOn !== undefined) {
      if (patch.dependsOn.length > 0) {
        await this.validateDependencies(patch.dependsOn);
      }
      await this.validateNoCycles(id, patch.dependsOn);
    }

    // Validate the gate-compatibility invariant against the resulting state.
    if (patch.dependsOn !== undefined || patch.gates !== undefined) {
      const effectiveDependsOn = patch.dependsOn ?? existing.dependsOn ?? [];
      const effectiveGates = patch.gates !== undefined ? patch.gates : existing.gates;
      // As a child: every parent must be compatible with at least this node's gates.
      await this.validateGateCompatibility(id, effectiveDependsOn, effectiveGates);
      // As a parent: every existing dependent must remain compatible with this
      // node's (possibly narrowed) gates.
      await this.validateDependentsRemainCompatible(id, effectiveGates);
    }

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.prompt !== undefined) update.prompt = patch.prompt.trim();
    if (patch.dependsOn !== undefined) update.dependsOn = patch.dependsOn;
    if (patch.gates !== undefined) update.gates = patch.gates;

    await this.collection.updateOne(
      this.scoped({ id, deletedAt: { $exists: false } }),
      { $set: update }
    );

    return (await this.get(id))!;
  }

  /**
   * Soft-delete a criterion.
   * Rejects if other active criteria depend on this one.
   */
  async delete(id: string): Promise<void> {
    const existing = await this.get(id);
    if (!existing) {
      throw new CriteriaNotFoundError(`Criteria '${id}' not found`);
    }

    // Check for dependents (within the same project)
    const dependents = await this.collection
      .find(this.scoped({
        dependsOn: id,
        deletedAt: { $exists: false },
      }))
      .toArray();

    if (dependents.length > 0) {
      const depIds = dependents.map((d) => d.id);
      throw new CriteriaHasDependentsError(
        `Cannot delete '${id}': other criteria depend on it: ${depIds.join(', ')}`,
        depIds
      );
    }

    await this.collection.updateOne(
      this.scoped({ id, deletedAt: { $exists: false } }),
      { $set: { deletedAt: new Date() } }
    );
  }

  /**
   * Resolve criteria IDs to CriteriaConfig objects, including all transitive ancestors.
   * Same BFS logic as FileSystemCriteriaProvider.resolveWithAncestors but reads from MongoDB.
   */
  async resolveWithAncestors(ids: string[]): Promise<CriteriaConfig[]> {
    const collected = new Map<string, CriteriaConfig>();
    const queue = [...ids];

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (collected.has(id)) continue;

      const doc = await this.get(id);
      if (!doc) {
        const all = await this.getAll();
        const availableIds = all.map((c) => c.id).join(', ');
        throw new Error(
          `Criteria '${id}' not found in store. Available: ${availableIds || 'none'}`
        );
      }

      collected.set(id, { id: doc.id, prompt: doc.prompt, dependsOn: doc.dependsOn, ...(doc.gates !== undefined && { gates: doc.gates }) });

      if (doc.dependsOn) {
        for (const parentId of doc.dependsOn) {
          if (!collected.has(parentId)) {
            queue.push(parentId);
          }
        }
      }
    }

    return Array.from(collected.values());
  }

  /**
   * Get the full DAG as nodes + edges for visualization.
   */
  async getGraph(): Promise<{
    nodes: CriteriaConfig[];
    edges: { from: string; to: string }[];
  }> {
    const all = await this.getAll();
    const nodes: CriteriaConfig[] = all.map((c) => ({
      id: c.id,
      prompt: c.prompt,
      dependsOn: c.dependsOn,
      ...(c.gates !== undefined && { gates: c.gates }),
    }));

    const edges: { from: string; to: string }[] = [];
    for (const criterion of all) {
      if (criterion.dependsOn) {
        for (const parentId of criterion.dependsOn) {
          edges.push({ from: parentId, to: criterion.id });
        }
      }
    }

    return { nodes, edges };
  }

  /**
   * Seed criteria from YAML-loaded configs (upsert — skip existing).
   * Returns the number of newly inserted criteria.
   */
  async seed(configs: CriteriaConfig[]): Promise<number> {
    let inserted = 0;
    for (const config of configs) {
      const existing = await this.collection.findOne(this.scoped({ id: config.id }));
      if (!existing) {
        await this.collection.insertOne({
          ...(this.projectId ? { projectId: this.projectId } : {}),
          id: config.id,
          prompt: config.prompt,
          dependsOn: config.dependsOn || [],
          ...(config.gates !== undefined && { gates: config.gates }),
          createdAt: new Date(),
        } as any);
        inserted++;
      }
    }
    return inserted;
  }

  // --- Private helpers ---

  /** Validate that all referenced dependency IDs exist in the store */
  private async validateDependencies(dependsOn: string[]): Promise<void> {
    for (const depId of dependsOn) {
      const dep = await this.get(depId);
      if (!dep) {
        throw new CriteriaValidationError(`Dependency '${depId}' does not exist`);
      }
    }
  }

  /** Validate that adding edges would not introduce a cycle */
  private async validateNoCycles(
    criterionId: string,
    dependsOn: string[]
  ): Promise<void> {
    // Build a temporary in-memory graph with the proposed change
    const all = await this.getAll();
    const configs: CriteriaConfig[] = all.map((c) => ({
      id: c.id,
      prompt: c.prompt,
      dependsOn: c.id === criterionId ? dependsOn : c.dependsOn,
    }));

    // If this is a new criterion, add it
    if (!configs.some((c) => c.id === criterionId)) {
      configs.push({ id: criterionId, prompt: '(pending)', dependsOn });
    }

    try {
      new DependencyGraph(configs);
    } catch (error) {
      if (error instanceof Error && error.message.includes('ycle')) {
        throw new CriteriaValidationError(
          `Adding dependencies [${dependsOn.join(', ')}] to '${criterionId}' would create a cycle`
        );
      }
      throw error;
    }
  }

  /**
   * Enforce the downward-closed gate-compatibility invariant: every direct
   * parent of `criterionId` must be compatible with at least every gate the
   * child is compatible with (`compat(parent) ⊇ compat(child)`).
   *
   * Ancestors are resolved transitively by the parents themselves satisfying
   * the same rule, so checking direct parents is sufficient. An unrestricted
   * child (empty/undefined gates = all gates) requires its parents to also be
   * unrestricted.
   */
  private async validateGateCompatibility(
    criterionId: string,
    dependsOn: string[],
    gates: GateId[] | undefined,
  ): Promise<void> {
    if (dependsOn.length === 0) return;

    for (const parentId of dependsOn) {
      const parent = await this.get(parentId);
      // Missing parents are caught by validateDependencies; skip here.
      if (!parent) continue;
      if (!gatesSatisfyInvariant(parent.gates, gates)) {
        const childGates = !gates || gates.length === 0 ? "all gates" : gates.join(", ");
        const parentGates =
          !parent.gates || parent.gates.length === 0 ? "all gates" : parent.gates.join(", ");
        throw new CriteriaValidationError(
          `'${criterionId}' is compatible with [${childGates}] but its dependency ` +
            `'${parentId}' is not (compatible with: ${parentGates}). A dependency must be ` +
            `compatible with at least every gate its dependent is.`,
        );
      }
    }
  }

  /**
   * Enforce the same invariant from the parent side: every active criterion that
   * depends on `criterionId` must remain compatible with `criterionId`'s
   * (possibly narrowed) gates after an update (`compat(this) ⊇ compat(dependent)`).
   */
  private async validateDependentsRemainCompatible(
    criterionId: string,
    gates: GateId[] | undefined,
  ): Promise<void> {
    const dependents = await this.collection
      .find(this.scoped({ dependsOn: criterionId, deletedAt: { $exists: false } }))
      .toArray();

    for (const child of dependents) {
      if (!gatesSatisfyInvariant(gates, child.gates)) {
        const thisGates = !gates || gates.length === 0 ? "all gates" : gates.join(", ");
        const childGates =
          !child.gates || child.gates.length === 0 ? "all gates" : child.gates.join(", ");
        throw new CriteriaValidationError(
          `Dependent '${child.id}' is compatible with [${childGates}] but '${criterionId}' ` +
            `would be compatible with [${thisGates}] after this change. A dependency must be ` +
            `compatible with at least every gate its dependent is.`,
        );
      }
    }
  }
}
