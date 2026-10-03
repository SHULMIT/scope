// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi } from "vitest";
import type { Db } from "mongodb";

// ─── Fakes ───────────────────────────────────────────────────────────────────

/**
 * A minimal fake collection recording the calls migration 025 makes. `find()`
 * and `aggregate()` return configurable results; everything else records args.
 */
function makeCollection(opts: { cursorDocs?: any[]; aggregateResult?: any[]; findOne?: any } = {}) {
  const cursorDocs = opts.cursorDocs ?? [{ _id: "doc-1" }];
  const aggregateResult = opts.aggregateResult ?? [];
  const col: any = {
    createIndex: vi.fn(async (key: any) => Object.keys(key).join("_")),
    dropIndex: vi.fn(async () => undefined),
    updateMany: vi.fn(async (_filter: any, _update: any) => ({ modifiedCount: cursorDocs.length })),
    bulkWrite: vi.fn(async (ops: any[]) => ({ modifiedCount: ops.length })),
    insertOne: vi.fn(async (_doc: any) => ({ acknowledged: true })),
    findOne: vi.fn(async () => opts.findOne ?? null),
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

const SCOPED = [
  "requests",
  "profiles",
  "criteria",
  "prompt-features",
  "mcp-servers",
  "report-templates",
  "skills",
  "extensions",
  "codebases",
  "runs",
  "profile-versions",
  "codebase-revisions",
  "reports",
  "insights",
  "task-prompts",
  "skill-revisions",
];

const { CreateProjects } = await import("./migrations/025-create-projects.js");

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("migration 025: CreateProjects", () => {
  describe("up()", () => {
    it("inserts one initial project and backfills its id across all scoped collections", async () => {
      const db = makeDb();
      await new CreateProjects().up(db);

      const projects = (db as any).collection("projects");
      expect(projects.insertOne).toHaveBeenCalledTimes(1);
      const inserted = projects.insertOne.mock.calls[0][0];
      expect(typeof inserted._id).toBe("string");
      expect(inserted.name).toBe("Initial Project");
      expect(inserted).not.toHaveProperty("isDefault");

      for (const name of SCOPED) {
        const col = (db as any).collection(name);
        expect(col.updateMany, `${name} backfilled`).toHaveBeenCalled();
        // batchUpdate applies the $exists filter on find(), then updateMany({_id:{$in}}, update).
        const findFilters = col.find.mock.calls.map(([f]: any[]) => JSON.stringify(f));
        expect(findFilters).toContain(JSON.stringify({ projectId: { $exists: false } }));
        expect(col.updateMany.mock.calls[0][1]).toEqual({ $set: { projectId: inserted._id } });
      }
    });

    it("adds { projectId } and { projectId, _id } indexes to every scoped collection", async () => {
      const db = makeDb();
      await new CreateProjects().up(db);

      for (const name of SCOPED) {
        const col = (db as any).collection(name);
        const keys = col.createIndex.mock.calls.map(([k]: any[]) => JSON.stringify(k));
        expect(keys, `${name} has {projectId}`).toContain(JSON.stringify({ projectId: 1 }));
        expect(keys, `${name} has {projectId,_id}`).toContain(
          JSON.stringify({ projectId: 1, _id: 1 }),
        );
      }
    });

    it("swaps the skill-revisions unique index and adds the task-prompts composite unique index", async () => {
      const db = makeDb();
      await new CreateProjects().up(db);

      const skills = (db as any).collection("skill-revisions");
      expect(skills.dropIndex).toHaveBeenCalledWith({ ref: 1 });
      const skillUnique = skills.createIndex.mock.calls.find(
        ([k]: any[]) => JSON.stringify(k) === JSON.stringify({ projectId: 1, ref: 1 }),
      );
      expect(skillUnique?.[1]).toEqual({ unique: true });

      const prompts = (db as any).collection("task-prompts");
      const promptUnique = prompts.createIndex.mock.calls.find(
        ([k]: any[]) => JSON.stringify(k) === JSON.stringify({ projectId: 1, keyId: 1 }),
      );
      expect(promptUnique?.[1]).toEqual({ unique: true });
      // keyId backfill copies _id
      expect(prompts.bulkWrite).toHaveBeenCalled();
    });

    it("reuses the oldest existing project on re-run (no second insert)", async () => {
      const db = makeDb({ projects: makeCollection({ findOne: { _id: "existing-proj" } }) });
      await new CreateProjects().up(db);

      const projects = (db as any).collection("projects");
      expect(projects.insertOne).not.toHaveBeenCalled();
      const [, update] = (db as any).collection("requests").updateMany.mock.calls[0];
      expect(update).toEqual({ $set: { projectId: "existing-proj" } });
    });

    it("throws when a pre-existing composite-key collision would break the unique index", async () => {
      const db = makeDb({
        "skill-revisions": makeCollection({ aggregateResult: [{ _id: {}, count: 2 }] }),
      });
      await expect(new CreateProjects().up(db)).rejects.toThrow(/duplicate/i);
    });

    it("falls back to a non-unique index when Cosmos rejects a unique index on an empty, already-created collection (403 'cannot be modified')", async () => {
      // Cosmos returns HTTP 403 (mapped to code 13) when asked to add a unique
      // key policy to a collection that already exists — even when it is empty.
      // This is distinct from the code-67 "populated" case and must ALSO degrade
      // to a non-unique index rather than crash the migration.
      const err: any = new Error(
        "Error=13, Details='Forbidden (403): The unique index cannot be modified. " +
          "To change the unique index, remove the collection and re-create a new one.'",
      );
      err.code = 13;
      const skillRev = makeCollection();
      skillRev.createIndex = vi.fn(async (key: any, options: any = {}) => {
        if (options.unique) throw err;
        return Object.keys(key).join("_");
      });
      const db = makeDb({ "skill-revisions": skillRev });

      await expect(new CreateProjects().up(db)).resolves.toBeUndefined();

      const calls = skillRev.createIndex.mock.calls;
      const uniqueAttempt = calls.find(
        ([k, o]: any[]) =>
          JSON.stringify(k) === JSON.stringify({ projectId: 1, ref: 1 }) && o?.unique,
      );
      const nonUniqueFallback = calls.find(
        ([k, o]: any[]) =>
          JSON.stringify(k) === JSON.stringify({ projectId: 1, ref: 1 }) && !o?.unique,
      );
      expect(uniqueAttempt).toBeTruthy(); // it tried unique first
      expect(nonUniqueFallback).toBeTruthy(); // then fell back to non-unique
    });

    it("re-throws a genuine authorization error (code 13) that is not the Cosmos unique-index signal", async () => {
      const err: any = new Error("Error=13, not authorized on db to execute command");
      err.code = 13;
      const skillRev = makeCollection();
      skillRev.createIndex = vi.fn(async (key: any, options: any = {}) => {
        if (options.unique) throw err;
        return Object.keys(key).join("_");
      });
      const db = makeDb({ "skill-revisions": skillRev });
      await expect(new CreateProjects().up(db)).rejects.toThrow(/not authorized/i);
    });
  });

  describe("down()", () => {
    it("unsets projectId on every scoped collection and keyId on task-prompts", async () => {
      const db = makeDb();
      await new CreateProjects().down(db);

      for (const name of SCOPED) {
        const col = (db as any).collection(name);
        const findFilters = col.find.mock.calls.map(([f]: any[]) => JSON.stringify(f));
        expect(findFilters).toContain(JSON.stringify({ projectId: { $exists: true } }));
        expect(col.updateMany.mock.calls[0][1]).toEqual({ $unset: { projectId: "" } });
      }
      const prompts = (db as any).collection("task-prompts");
      const keyIdCall = prompts.updateMany.mock.calls.find(
        ([, u]: any[]) => JSON.stringify(u) === JSON.stringify({ $unset: { keyId: "" } }),
      );
      expect(keyIdCall).toBeTruthy();
    });
  });
});
