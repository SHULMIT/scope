// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection } from 'mongodb';
import { randomUUID } from 'crypto';
import type { SkillRevisionDocument } from '../types/skill.js';

/**
 * MongoDB-backed store for skill revision entities.
 *
 * Skill revisions are **immutable and per-project**: the `_id` is a fresh UUID,
 * and the human-readable `ref` (`{source}/{skillName}@{commitHash}`) is the
 * natural key **within a project**. Per-project uniqueness is backed by a
 * `{ projectId, ref }` index — **unique** on real MongoDB, and (on Azure Cosmos
 * DB for MongoDB, which cannot build a unique index on a populated collection)
 * **non-unique**, with uniqueness enforced by `findOrCreate`. Two projects that
 * resolve the same skill ref get **two distinct documents** (same `ref`,
 * distinct `_id`, distinct `projectId`).
 *
 * `findOrCreate` is idempotent **within a project** — calling it multiple times
 * with the same `(projectId, ref)` returns the same document without
 * duplication.
 */
export class SkillRevisionStore {
  constructor(private collection: Collection<SkillRevisionDocument>) {}

  /** Get a single skill revision by ID (globally-unique UUID). Point read. */
  async get(id: string): Promise<SkillRevisionDocument | null> {
    return this.collection.findOne({ _id: id });
  }

  /** Get a skill revision by its human-readable ref string within a project */
  async getByRef(projectId: string, ref: string): Promise<SkillRevisionDocument | null> {
    return this.collection.findOne({ projectId, ref });
  }

  /**
   * Find an existing skill revision by `(projectId, ref)`, or create a new one.
   * Idempotent within a project — same `(projectId, ref)` always returns the
   * same document. Distinct projects get distinct documents for the same ref.
   *
   * @param doc - The full skill revision document to insert (if not already
   *              present), including its `projectId`. The `_id` is minted fresh.
   * @returns The existing or newly created document.
   */
  async findOrCreate(
    doc: Omit<SkillRevisionDocument, '_id' | 'createdAt'>
  ): Promise<SkillRevisionDocument> {
    // Try to find existing within this project
    const existing = await this.collection.findOne({
      projectId: doc.projectId,
      ref: doc.ref,
    });
    if (existing) {
      return existing;
    }

    // Create new document
    const fullDoc: SkillRevisionDocument = {
      ...doc,
      _id: randomUUID(),
      createdAt: new Date(),
    };

    await this.collection.insertOne(fullDoc as any);
    return fullDoc;
  }

  /**
   * List skill revisions for a given source + skillName within a project,
   * ordered by resolvedAt descending. Useful for seeing the revision history of
   * a particular skill.
   */
  async listBySkill(
    projectId: string,
    source: string,
    skillName: string,
    opts?: { limit?: number }
  ): Promise<SkillRevisionDocument[]> {
    return this.collection
      .find({ projectId, source, skillName })
      .sort({ resolvedAt: -1 })
      .limit(opts?.limit ?? 20)
      .toArray();
  }

  /**
   * Resolve multiple refs in bulk within a project, returning documents for
   * each. Used by the queue processor to resolve RequestDocument.skillRevisions
   * within the run's project.
   */
  async getByRefs(projectId: string, refs: string[]): Promise<SkillRevisionDocument[]> {
    if (refs.length === 0) return [];

    return this.collection.find({ projectId, ref: { $in: refs } }).toArray();
  }

  /**
   * Delete all revisions for a given source + skillName within a project.
   * Used when a skill is deleted to clean up associated revision data.
   *
   * @returns The number of deleted revision documents.
   */
  async deleteBySkill(projectId: string, source: string, skillName: string): Promise<number> {
    const result = await this.collection.deleteMany({ projectId, source, skillName });
    return result.deletedCount;
  }
}
