// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach } from "vitest";
import { PromptFeatureStore } from "./prompt-feature-store.js";
import type { PromptFeatureDocument } from "../types/types.js";

// ── Minimal in-memory collection ─────────────────────────────────────────────
// Supports the subset of query operators the store uses: `id`, `deletedAt`
// existence, and the `$or`/`type` existence filters for type scoping.

function matchesType(doc: PromptFeatureDocument, clause: any): boolean {
  if (clause.type !== undefined) {
    if (typeof clause.type === "object" && clause.type.$exists === false) {
      return doc.type === undefined;
    }
    return doc.type === clause.type;
  }
  return true;
}

function createMockCollection() {
  const docs: PromptFeatureDocument[] = [];

  return {
    _docs: docs,
    find(filter: any) {
      let results = docs.filter((d) => {
        if (filter.deletedAt && filter.deletedAt.$exists === false && d.deletedAt) return false;
        if (filter.$or) {
          if (!filter.$or.some((clause: any) => matchesType(d, clause))) return false;
        }
        return true;
      });
      return {
        sort() { return this; },
        toArray() { return Promise.resolve(results.map((d) => ({ ...d }))); },
      };
    },
    findOne(filter: any) {
      const doc = docs.find((d) => {
        if (filter.id && d.id !== filter.id) return false;
        if (filter.deletedAt && filter.deletedAt.$exists === false && d.deletedAt) return false;
        return true;
      });
      return Promise.resolve(doc ? { ...doc } : null);
    },
    insertOne(doc: PromptFeatureDocument) {
      docs.push({ ...doc });
      return Promise.resolve({ insertedId: doc.id });
    },
    updateOne() { return Promise.resolve({ matchedCount: 1, modifiedCount: 1 }); },
  };
}

describe("PromptFeatureStore type support", () => {
  let store: PromptFeatureStore;
  let collection: ReturnType<typeof createMockCollection>;

  beforeEach(() => {
    collection = createMockCollection();
    store = new PromptFeatureStore(collection as any);
  });

  it("create persists the type field when provided", async () => {
    const doc = await store.create({ projectId: "proj-test", id: "agents_terse", prompt: "Be terse", type: "agents.md" });
    expect(doc.type).toBe("agents.md");
    expect(collection._docs[0].type).toBe("agents.md");
  });

  it("create omits type when not provided (backward compatible)", async () => {
    const doc = await store.create({ projectId: "proj-test", id: "task_feat", prompt: "A task feature" });
    expect(doc.type).toBeUndefined();
    expect("type" in collection._docs[0]).toBe(false);
  });

  it("getAll({type: 'agents.md'}) returns only agents.md features", async () => {
    await store.create({ projectId: "proj-test", id: "task_a", prompt: "p", type: "select" });
    await store.create({ projectId: "proj-test", id: "legacy", prompt: "p" }); // no type → select
    await store.create({ projectId: "proj-test", id: "agents_b", prompt: "p", type: "agents.md" });

    const result = await store.getAll({ type: "agents.md" });
    expect(result.map((f) => f.id)).toEqual(["agents_b"]);
  });

  it("getAll({type: 'select'}) includes legacy (untyped) features", async () => {
    await store.create({ projectId: "proj-test", id: "task_a", prompt: "p", type: "select" });
    await store.create({ projectId: "proj-test", id: "legacy", prompt: "p" });
    await store.create({ projectId: "proj-test", id: "agents_b", prompt: "p", type: "agents.md" });

    const result = await store.getAll({ type: "select" });
    expect(result.map((f) => f.id).sort()).toEqual(["legacy", "task_a"]);
  });

  it("getAll() with no filter returns all features", async () => {
    await store.create({ projectId: "proj-test", id: "task_a", prompt: "p" });
    await store.create({ projectId: "proj-test", id: "agents_b", prompt: "p", type: "agents.md" });

    const result = await store.getAll();
    expect(result).toHaveLength(2);
  });

  it("seed carries the type field for new features", async () => {
    const inserted = await store.seed([
      { id: "agents_seed", prompt: "p", type: "agents.md" },
      { id: "task_seed", prompt: "p" },
    ]);
    expect(inserted).toBe(2);
    expect(collection._docs.find((d) => d.id === "agents_seed")?.type).toBe("agents.md");
    expect("type" in (collection._docs.find((d) => d.id === "task_seed") as any)).toBe(false);
  });
});
