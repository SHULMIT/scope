// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Collection } from "mongodb";
import { randomUUID } from "crypto";
import type { ProjectDocument } from "../types/project.js";

/** Input for creating a new project. */
export interface CreateProjectInput {
  name: string;
  description?: string;
  creator?: string;
}

/** Mutable fields that can be patched on a project. */
export interface UpdateProjectInput {
  name?: string;
  description?: string;
}

/**
 * MongoDB-backed store for the mutable `projects` collection.
 *
 * A project is an ordinary, re-nameable container. There is **no default
 * project** — the store deliberately exposes no `getDefault`/`ensureDefault`
 * helper. Callers that cannot resolve a project must fail, never fall back.
 */
export class ProjectStore {
  constructor(private collection: Collection<ProjectDocument>) {}

  /** Get a project by its UUID `_id` (excludes soft-deleted by default). */
  async get(id: string, opts?: { includeDeleted?: boolean }): Promise<ProjectDocument | null> {
    const filter: Record<string, unknown> = { _id: id };
    if (!opts?.includeDeleted) filter.deletedAt = { $exists: false };
    return this.collection.findOne(filter as object) as Promise<ProjectDocument | null>;
  }

  /** List projects, newest first (excludes soft-deleted by default). */
  async list(opts?: { includeDeleted?: boolean }): Promise<ProjectDocument[]> {
    const filter = opts?.includeDeleted ? {} : { deletedAt: { $exists: false } };
    return this.collection.find(filter).sort({ createdAt: -1 }).toArray();
  }

  /** Create a new project with a fresh UUID `_id`. */
  async create(input: CreateProjectInput): Promise<ProjectDocument> {
    const name = input.name?.trim();
    if (!name) {
      throw new Error("Project name is required");
    }

    const doc: ProjectDocument = {
      _id: randomUUID(),
      name,
      ...(input.description ? { description: input.description } : {}),
      ...(input.creator ? { creator: input.creator } : {}),
      createdAt: new Date(),
    };
    await this.collection.insertOne(doc as ProjectDocument);
    return doc;
  }

  /** Patch mutable metadata. Returns the updated document, or null if not found. */
  async update(id: string, patch: UpdateProjectInput): Promise<ProjectDocument | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;

    const result = await this.collection.findOneAndUpdate(
      { _id: id, deletedAt: { $exists: false } } as object,
      { $set: set },
      { returnDocument: "after" }
    );
    return (result as ProjectDocument | null) ?? null;
  }

  /** Soft-delete a project (sets `deletedAt`). Returns true if a doc was updated. */
  async softDelete(id: string): Promise<boolean> {
    const result = await this.collection.updateOne(
      { _id: id, deletedAt: { $exists: false } } as object,
      { $set: { deletedAt: new Date() } }
    );
    return result.modifiedCount > 0;
  }

  /**
   * Restore a soft-deleted project by clearing its `deletedAt`. Only matches a
   * currently-deleted document, so restoring an already-active (or missing)
   * project is a no-op that returns `null`. Returns the restored document.
   */
  async restore(id: string): Promise<ProjectDocument | null> {
    const result = await this.collection.findOneAndUpdate(
      { _id: id, deletedAt: { $exists: true } } as object,
      { $unset: { deletedAt: "" } },
      { returnDocument: "after" }
    );
    return (result as ProjectDocument | null) ?? null;
  }
}
