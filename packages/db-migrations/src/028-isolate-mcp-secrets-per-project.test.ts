// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import type { Db } from "mongodb";

// ─── Fakes ───────────────────────────────────────────────────────────────────

/**
 * Minimal fake collection recording the calls migration 028 makes. `aggregate()`
 * feeds the `assertNoCompositeDuplicates` guard; everything else records args.
 */
function makeCollection(opts: { aggregateResult?: any[] } = {}) {
  const aggregateResult = opts.aggregateResult ?? [];
  const col: any = {
    createIndex: vi.fn(async (key: any) => Object.keys(key).join("_")),
    dropIndex: vi.fn(async () => undefined),
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

const COLLECTION = "mcp-secrets";
const NEW_KEY = { projectId: 1, mcpId: 1, name: 1 };
const LEGACY_KEY = { mcpId: 1, name: 1 };

const { IsolateMcpSecretsPerProject } = await import(
  "./migrations/028-isolate-mcp-secrets-per-project.js"
);

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("migration 028: IsolateMcpSecretsPerProject", () => {
  describe("up()", () => {
    it("drops the legacy global-unique {mcpId,name} and creates a per-project unique {projectId,mcpId,name}", async () => {
      const db = makeDb();
      await new IsolateMcpSecretsPerProject().up(db);

      const col = (db as any).collection(COLLECTION);
      expect(col.dropIndex, "drops legacy {mcpId,name}").toHaveBeenCalledWith(LEGACY_KEY);

      const unique = col.createIndex.mock.calls.find(
        ([k]: any[]) => JSON.stringify(k) === JSON.stringify(NEW_KEY),
      );
      expect(unique, "creates {projectId,mcpId,name}").toBeTruthy();
      expect(unique?.[1]).toEqual({ unique: true });
    });

    it("tolerates a not-found legacy index (Cosmos / fresh env) without throwing", async () => {
      const notFound: any = new Error("index not found with name [mcpId_1_name_1]");
      notFound.code = 27;
      const col = makeCollection();
      col.dropIndex = vi.fn(async () => {
        throw notFound;
      });
      const db = makeDb({ [COLLECTION]: col });

      await expect(new IsolateMcpSecretsPerProject().up(db)).resolves.toBeUndefined();
      // Still creates the per-project unique index after the tolerated drop.
      const unique = col.createIndex.mock.calls.find(
        ([k]: any[]) => JSON.stringify(k) === JSON.stringify(NEW_KEY),
      );
      expect(unique?.[1]).toEqual({ unique: true });
    });

    it("throws when a pre-existing {projectId,mcpId,name} collision would break the unique index", async () => {
      const db = makeDb({
        [COLLECTION]: makeCollection({ aggregateResult: [{ _id: {}, count: 2 }] }),
      });
      await expect(new IsolateMcpSecretsPerProject().up(db)).rejects.toThrow(/duplicate/i);
    });

    it("falls back to a non-unique index when Cosmos rejects a unique index (403 'cannot be modified')", async () => {
      const err: any = new Error(
        "Error=13, Details='Forbidden (403): The unique index cannot be modified. " +
          "To change the unique index, remove the collection and re-create a new one.'",
      );
      err.code = 13;
      const col = makeCollection();
      col.createIndex = vi.fn(async (key: any, options: any = {}) => {
        if (options.unique) throw err;
        return Object.keys(key).join("_");
      });
      const db = makeDb({ [COLLECTION]: col });

      await expect(new IsolateMcpSecretsPerProject().up(db)).resolves.toBeUndefined();

      const calls = col.createIndex.mock.calls;
      const uniqueAttempt = calls.find(
        ([k, o]: any[]) => JSON.stringify(k) === JSON.stringify(NEW_KEY) && o?.unique,
      );
      const nonUniqueFallback = calls.find(
        ([k, o]: any[]) => JSON.stringify(k) === JSON.stringify(NEW_KEY) && !o?.unique,
      );
      expect(uniqueAttempt).toBeTruthy();
      expect(nonUniqueFallback).toBeTruthy();
    });
  });

  describe("down()", () => {
    it("does not recreate the legacy global-unique index (log-only)", async () => {
      const db = makeDb();
      await new IsolateMcpSecretsPerProject().down(db);

      const col = (db as any).collection(COLLECTION);
      expect(col.createIndex).not.toHaveBeenCalled();
      expect(col.dropIndex).not.toHaveBeenCalled();
    });
  });
});
