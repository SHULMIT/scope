// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import type { Db } from "mongodb";

// ─── Fakes ───────────────────────────────────────────────────────────────────

/**
 * A minimal fake collection recording the calls migration 026 makes. `find()`
 * and `aggregate()` return configurable results; everything else records args.
 */
function makeCollection(opts: { cursorDocs?: any[]; aggregateResult?: any[] } = {}) {
  const cursorDocs = opts.cursorDocs ?? [{ _id: "slug-1" }];
  const aggregateResult = opts.aggregateResult ?? [];
  const col: any = {
    createIndex: vi.fn(async (key: any) => Object.keys(key).join("_")),
    dropIndex: vi.fn(async () => undefined),
    updateMany: vi.fn(async () => ({ modifiedCount: cursorDocs.length })),
    bulkWrite: vi.fn(async (ops: any[]) => ({ modifiedCount: ops.length })),
    find: vi.fn(() => ({
      [Symbol.asyncIterator]: async function* () {
        for (const d of cursorDocs) yield d;
      },
    })),
    aggregate: vi.fn(() => ({ toArray: async () => aggregateResult })),
  };
  return col;
}

/** Fake Db returning cached, per-name collections so calls accumulate. */
function makeDb(perName: Record<string, any> = {}): Db {
  const cache = new Map<string, any>();
  return {
    collection: vi.fn((name: string) => {
      if (!cache.has(name)) cache.set(name, perName[name] ?? makeCollection());
      return cache.get(name);
    }),
  } as any;
}

const SLUG_COLLECTIONS = ["skills", "extensions"];
const ID_COLLECTIONS = ["criteria", "prompt-features"];

const { IsolateCatalogsPerProject } = await import(
  "./migrations/026-isolate-catalogs-per-project.js"
);

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("migration 026: IsolateCatalogsPerProject", () => {
  describe("up()", () => {
    it("backfills slug = _id and adds a per-project unique {projectId, slug} index on skills/extensions", async () => {
      const db = makeDb();
      await new IsolateCatalogsPerProject().up(db);

      for (const name of SLUG_COLLECTIONS) {
        const col = (db as any).collection(name);
        // slug backfill copies _id via bulkWrite ($set slug = _id)
        expect(col.bulkWrite, `${name} slug backfilled`).toHaveBeenCalled();
        const setOps = col.bulkWrite.mock.calls[0][0].map(
          (o: any) => JSON.stringify(o.updateOne.update),
        );
        expect(setOps.some((s: string) => s.includes('"slug"'))).toBe(true);

        const unique = col.createIndex.mock.calls.find(
          ([k]: any[]) => JSON.stringify(k) === JSON.stringify({ projectId: 1, slug: 1 }),
        );
        expect(unique?.[1]).toEqual({ unique: true });
      }
    });

    it("swaps the global unique {id} for a per-project unique {projectId, id} on criteria/prompt-features", async () => {
      const db = makeDb();
      await new IsolateCatalogsPerProject().up(db);

      for (const name of ID_COLLECTIONS) {
        const col = (db as any).collection(name);
        expect(col.dropIndex, `${name} drops legacy {id}`).toHaveBeenCalledWith({ id: 1 });
        const unique = col.createIndex.mock.calls.find(
          ([k]: any[]) => JSON.stringify(k) === JSON.stringify({ projectId: 1, id: 1 }),
        );
        expect(unique?.[1]).toEqual({ unique: true });
      }
    });

    it("does not touch mcp-servers (deferred) or change any _id", async () => {
      const db = makeDb();
      await new IsolateCatalogsPerProject().up(db);
      const mcp = (db as any).collection("mcp-servers");
      expect(mcp.createIndex).not.toHaveBeenCalled();
      expect(mcp.bulkWrite).not.toHaveBeenCalled();
    });

    it("throws when a pre-existing {projectId, slug} collision would break the unique index", async () => {
      const db = makeDb({
        skills: makeCollection({ aggregateResult: [{ _id: {}, count: 2 }] }),
      });
      await expect(new IsolateCatalogsPerProject().up(db)).rejects.toThrow(/duplicate/i);
    });

    it("falls back to a non-unique index when Cosmos rejects a unique index (403 'cannot be modified')", async () => {
      const err: any = new Error(
        "Error=13, Details='Forbidden (403): The unique index cannot be modified. " +
          "To change the unique index, remove the collection and re-create a new one.'",
      );
      err.code = 13;
      const skills = makeCollection();
      skills.createIndex = vi.fn(async (key: any, options: any = {}) => {
        if (options.unique) throw err;
        return Object.keys(key).join("_");
      });
      const db = makeDb({ skills });

      await expect(new IsolateCatalogsPerProject().up(db)).resolves.toBeUndefined();

      const calls = skills.createIndex.mock.calls;
      const uniqueAttempt = calls.find(
        ([k, o]: any[]) =>
          JSON.stringify(k) === JSON.stringify({ projectId: 1, slug: 1 }) && o?.unique,
      );
      const nonUniqueFallback = calls.find(
        ([k, o]: any[]) =>
          JSON.stringify(k) === JSON.stringify({ projectId: 1, slug: 1 }) && !o?.unique,
      );
      expect(uniqueAttempt).toBeTruthy();
      expect(nonUniqueFallback).toBeTruthy();
    });

    it("re-throws a genuine authorization error (code 13) that is not the Cosmos unique-index signal", async () => {
      const err: any = new Error("Error=13, not authorized on db to execute command");
      err.code = 13;
      const skills = makeCollection();
      skills.createIndex = vi.fn(async (key: any, options: any = {}) => {
        if (options.unique) throw err;
        return Object.keys(key).join("_");
      });
      const db = makeDb({ skills });
      await expect(new IsolateCatalogsPerProject().up(db)).rejects.toThrow(/not authorized/i);
    });
  });

  describe("down()", () => {
    it("unsets slug on skills and extensions (index changes are log-only)", async () => {
      const db = makeDb();
      await new IsolateCatalogsPerProject().down(db);

      for (const name of SLUG_COLLECTIONS) {
        const col = (db as any).collection(name);
        const unsetCall = col.updateMany.mock.calls.find(
          ([, u]: any[]) => JSON.stringify(u) === JSON.stringify({ $unset: { slug: "" } }),
        );
        expect(unsetCall, `${name} slug unset`).toBeTruthy();
      }
      // criteria/prompt-features are not field-reverted (index-only change).
      const criteria = (db as any).collection("criteria");
      expect(criteria.updateMany).not.toHaveBeenCalled();
    });
  });
});
