// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import type { Db } from "mongodb";

// ─── Fakes ───────────────────────────────────────────────────────────────────

/**
 * A minimal fake collection recording the calls migration 027 makes. `find()`
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
function makeDb(
  perName: Record<string, any> = {},
  dropCollection: any = vi.fn(async () => true),
): Db {
  const cache = new Map<string, any>();
  return {
    collection: vi.fn((name: string) => {
      if (!cache.has(name)) cache.set(name, perName[name] ?? makeCollection());
      return cache.get(name);
    }),
    dropCollection,
  } as any;
}

const { UuidKeysMcpProfileVersions } = await import(
  "./migrations/027-uuid-keys-mcp-profileversions.js"
);

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("migration 027: UuidKeysMcpProfileVersions", () => {
  describe("up()", () => {
    it("backfills slug = _id and adds a per-project unique {projectId, slug} index on mcp-servers", async () => {
      const db = makeDb();
      await new UuidKeysMcpProfileVersions().up(db);

      const col = (db as any).collection("mcp-servers");
      expect(col.bulkWrite, "mcp-servers slug backfilled").toHaveBeenCalled();
      const setOps = col.bulkWrite.mock.calls[0][0].map(
        (o: any) => JSON.stringify(o.updateOne.update),
      );
      expect(setOps.some((s: string) => s.includes('"slug"'))).toBe(true);

      const unique = col.createIndex.mock.calls.find(
        ([k]: any[]) => JSON.stringify(k) === JSON.stringify({ projectId: 1, slug: 1 }),
      );
      expect(unique?.[1]).toEqual({ unique: true });
    });

    it("backfills ref = _id, adds unique {projectId, ref}, and retains {profileId, version} on profile-versions", async () => {
      const db = makeDb();
      await new UuidKeysMcpProfileVersions().up(db);

      const col = (db as any).collection("profile-versions");
      const setOps = col.bulkWrite.mock.calls[0][0].map(
        (o: any) => JSON.stringify(o.updateOne.update),
      );
      expect(setOps.some((s: string) => s.includes('"ref"'))).toBe(true);

      const uniqueRef = col.createIndex.mock.calls.find(
        ([k]: any[]) => JSON.stringify(k) === JSON.stringify({ projectId: 1, ref: 1 }),
      );
      expect(uniqueRef?.[1]).toEqual({ unique: true });

      const latestVersion = col.createIndex.mock.calls.find(
        ([k]: any[]) => JSON.stringify(k) === JSON.stringify({ profileId: 1, version: 1 }),
      );
      expect(latestVersion, "{profileId, version} retained").toBeTruthy();
    });

    it("drops the dead prompt-feature-extractions collection", async () => {
      const drop = vi.fn(async () => true);
      const db = makeDb({}, drop);
      await new UuidKeysMcpProfileVersions().up(db);
      expect(drop).toHaveBeenCalledWith("prompt-feature-extractions");
    });

    it("tolerates the dead collection already being absent (NamespaceNotFound)", async () => {
      const err: any = new Error("ns not found");
      err.codeName = "NamespaceNotFound";
      const drop = vi.fn(async () => {
        throw err;
      });
      const db = makeDb({}, drop);
      await expect(new UuidKeysMcpProfileVersions().up(db)).resolves.toBeUndefined();
    });

    it("throws when a pre-existing {projectId, slug} collision would break the unique index", async () => {
      const db = makeDb({
        "mcp-servers": makeCollection({ aggregateResult: [{ _id: {}, count: 2 }] }),
      });
      await expect(new UuidKeysMcpProfileVersions().up(db)).rejects.toThrow(/duplicate/i);
    });

    it("falls back to a non-unique index when Cosmos rejects a unique index (403 'cannot be modified')", async () => {
      const err: any = new Error(
        "Error=13, Details='Forbidden (403): The unique index cannot be modified. " +
          "To change the unique index, remove the collection and re-create a new one.'",
      );
      err.code = 13;
      const servers = makeCollection();
      servers.createIndex = vi.fn(async (key: any, options: any = {}) => {
        if (options.unique) throw err;
        return Object.keys(key).join("_");
      });
      const db = makeDb({ "mcp-servers": servers });

      await expect(new UuidKeysMcpProfileVersions().up(db)).resolves.toBeUndefined();

      const calls = servers.createIndex.mock.calls;
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
      const servers = makeCollection();
      servers.createIndex = vi.fn(async (key: any, options: any = {}) => {
        if (options.unique) throw err;
        return Object.keys(key).join("_");
      });
      const db = makeDb({ "mcp-servers": servers });
      await expect(new UuidKeysMcpProfileVersions().up(db)).rejects.toThrow(/not authorized/i);
    });
  });

  describe("down()", () => {
    it("unsets slug (mcp-servers) and ref (profile-versions); index/collection changes are log-only", async () => {
      const drop = vi.fn(async () => true);
      const db = makeDb({}, drop);
      await new UuidKeysMcpProfileVersions().down(db);

      const servers = (db as any).collection("mcp-servers");
      const slugUnset = servers.updateMany.mock.calls.find(
        ([, u]: any[]) => JSON.stringify(u) === JSON.stringify({ $unset: { slug: "" } }),
      );
      expect(slugUnset, "mcp-servers slug unset").toBeTruthy();

      const versions = (db as any).collection("profile-versions");
      const refUnset = versions.updateMany.mock.calls.find(
        ([, u]: any[]) => JSON.stringify(u) === JSON.stringify({ $unset: { ref: "" } }),
      );
      expect(refUnset, "profile-versions ref unset").toBeTruthy();

      // down() must not recreate the dropped dead collection.
      expect(drop).not.toHaveBeenCalled();
    });
  });
});
