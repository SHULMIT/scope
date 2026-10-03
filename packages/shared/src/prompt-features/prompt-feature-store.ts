// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection, Filter } from 'mongodb';
import { PromptFeatureConfig, PromptFeatureDocument, PromptType } from '../types/types.js';

/**
 * MongoDB-backed prompt feature store for CRUD operations on prompt feature definitions.
 *
 * Manages prompt features that describe detectable characteristics in task prompts
 * (as opposed to codebases). Documents are soft-deleted (deletedAt) rather than removed.
 */
export class PromptFeatureStore {
  constructor(private collection: Collection<PromptFeatureDocument>) {}

  /** List all active (non-deleted) prompt features, optionally filtered by type */
  async getAll(opts?: { type?: PromptType }): Promise<PromptFeatureDocument[]> {
    const filter: Filter<PromptFeatureDocument> = { deletedAt: { $exists: false } };
    if (opts?.type) {
      // Absent `type` is treated as 'select' for backward compatibility
      // (legacy prompt features predate typing and target the scenario task).
      filter.$or =
        opts.type === "select"
          ? [{ type: "select" }, { type: { $exists: false } }]
          : [{ type: opts.type }];
    }
    return this.collection
      .find(filter)
      .sort({ id: 1 })
      .toArray();
  }

  /** Get a single prompt feature by ID */
  async get(id: string): Promise<PromptFeatureDocument | null> {
    return this.collection.findOne({ id, deletedAt: { $exists: false } });
  }

  /** Create a new prompt feature. Validates uniqueness. */
  async create(input: {
    projectId: string;
    id: string;
    prompt: string;
    type?: PromptType;
  }): Promise<PromptFeatureDocument> {
    const { projectId, id, prompt, type } = input;

    // Validate ID format
    if (!/^[a-z0-9_-]+$/.test(id)) {
      throw new Error(
        `Invalid prompt feature ID '${id}'. Must match [a-z0-9_-]+`
      );
    }

    // Check for duplicates
    const existing = await this.collection.findOne({ id, deletedAt: { $exists: false } });
    if (existing) {
      throw new Error(`Prompt feature '${id}' already exists`);
    }

    const doc: PromptFeatureDocument = {
      projectId,
      id,
      prompt: prompt.trim(),
      ...(type ? { type } : {}),
      createdAt: new Date(),
    };

    await this.collection.insertOne(doc as any);
    return doc;
  }

  /** Update a prompt feature's prompt */
  async update(
    id: string,
    patch: { prompt?: string }
  ): Promise<PromptFeatureDocument> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Prompt feature '${id}' not found`);
    }

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.prompt !== undefined) update.prompt = patch.prompt.trim();

    await this.collection.updateOne(
      { id, deletedAt: { $exists: false } },
      { $set: update }
    );

    return (await this.get(id))!;
  }

  /** Soft-delete a prompt feature. */
  async delete(id: string): Promise<void> {
    const existing = await this.get(id);
    if (!existing) {
      throw new Error(`Prompt feature '${id}' not found`);
    }

    await this.collection.updateOne(
      { id, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date() } }
    );
  }

  /**
   * Seed prompt features from configs (upsert — skip existing).
   * Returns the number of newly inserted prompt features.
   */
  async seed(configs: PromptFeatureConfig[]): Promise<number> {
    let inserted = 0;
    for (const config of configs) {
      const existing = await this.collection.findOne({ id: config.id });
      if (!existing) {
        await this.collection.insertOne({
          id: config.id,
          prompt: config.prompt,
          ...(config.type ? { type: config.type } : {}),
          createdAt: new Date(),
        } as any);
        inserted++;
      }
    }
    return inserted;
  }
}
