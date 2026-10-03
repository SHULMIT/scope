// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Data Organization — Projects (#1210).
 *
 * Introduces the first-class `projects` container and files every existing
 * scoped document into **one ordinary initial project**. Behaviour-preserving:
 * post-migration all existing data sits in that single project, so today's
 * listings are unchanged (just scoped to it).
 *
 * There is **no Default project and no `isDefault` flag** — the initial project
 * is a normal, re-nameable project. It is simply the oldest one, which is how
 * this migration re-locates it on re-run (idempotency).
 *
 * Steps (up):
 *   1. Create the `projects` collection + its indexes.
 *   2. Insert exactly one initial project (fresh UUID `_id`), or reuse the
 *      existing oldest project on re-run.
 *   3. Backfill `projectId = <initialId>` on every scoped collection (RU-paced).
 *   4. Deterministic-key entities:
 *        - task-prompts: backfill `keyId = _id` (legacy `_id` is already the
 *          content-address `computePromptId(type,text)`, so `keyId === _id`).
 *        - skill-revisions: `ref` already present — nothing to backfill.
 *      Then swap unique indexes:
 *        - skill-revisions `{ref}` → `{projectId, ref}` (unique).
 *        - task-prompts add unique `{projectId, keyId}`.
 *      A pre-assert guards against pre-existing composite-key collisions (which
 *      would make unique-index creation fail on real MongoDB).
 *
 *      **Cosmos DB caveat (RU-based):** a unique index can only be created while
 *      the collection is empty / at creation time (via the CreateCollection
 *      extension command). `createIndex(..., {unique:true})` on an already-created
 *      collection fails either with code 67 (populated) or HTTP 403 "unique index
 *      cannot be modified" (empty-but-created). We therefore degrade gracefully:
 *      on either signal we create a **non-unique** index on the same key (kept for
 *      lookup performance) and rely on the application-level `findOrCreate` for
 *      per-project dedup — which is already how these collections behave on Cosmos
 *      today (migration 003's unique `{ref}` index silently no-op'd there). Real
 *      MongoDB (local/CI) still gets true unique indexes, so unit/integration
 *      tests continue to assert uniqueness.
 *   5. Add scoping indexes `{projectId}` and `{projectId, _id}` on every scoped
 *      collection (supports the required `?projectId=` list filter).
 *
 * down(): unset `projectId` (all scoped) + `keyId` (task-prompts); index changes
 * are log-only (drop manually if needed), matching the repo convention.
 */

import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import { batchUpdate } from "../batch-update.js";
import {
  assertNoCompositeDuplicates,
  backfillFieldFromId,
  dropIndexSafe,
  ensureIndex,
  ensureUniqueIndexOrFallback,
} from "../cosmos-index-helpers.js";

/** Every scoped collection that receives a `projectId`. Source: A0 map. */
const SCOPED_COLLECTIONS = [
  // ROOT (projectId from ?projectId= at create)
  "requests",
  "profiles",
  "criteria",
  "prompt-features",
  "mcp-servers",
  "report-templates",
  "skills",
  "extensions",
  "codebases",
  // CHILD (projectId copied from a parent)
  "runs",
  "profile-versions",
  "codebase-revisions",
  "reports",
  "insights",
  // SPECIAL / A4 (per-project copies)
  "task-prompts",
  "skill-revisions",
] as const;

const DEFAULT_INITIAL_PROJECT_NAME = "Initial Project";

export class CreateProjects implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const projects = db.collection("projects");

    // 1. projects collection + indexes (createIndex auto-creates the collection).
    await ensureIndex(projects, { createdAt: -1 }, {}, "projects", "025");
    await ensureIndex(projects, { deletedAt: 1 }, {}, "projects", "025");

    // 2. One initial project. Reuse the oldest on re-run (idempotent) — the
    //    initial project is always the oldest, since the migration creates it
    //    before any user-made project can exist.
    let initial = await projects.findOne({}, { sort: { createdAt: 1 } });
    if (!initial) {
      const now = new Date();
      const doc = {
        _id: randomUUID(),
        name: process.env.SCOPE_INITIAL_PROJECT_NAME || DEFAULT_INITIAL_PROJECT_NAME,
        createdAt: now,
      };
      await projects.insertOne(doc as any);
      initial = doc as any;
      console.log(`  [025] inserted initial project "${doc.name}" (${doc._id})`);
    } else {
      console.log(`  [025] reusing existing initial project (${initial._id})`);
    }
    const initialId = initial!._id as unknown as string;

    // 3. Backfill projectId on every scoped collection (only where missing).
    for (const name of SCOPED_COLLECTIONS) {
      await batchUpdate(
        db.collection(name),
        { projectId: { $exists: false } },
        { $set: { projectId: initialId } },
        `[025] backfill ${name}.projectId`,
      );
    }

    // 4. Deterministic-key entities.
    // 4a. task-prompts keyId = _id (legacy _id is already the content-address).
    await backfillFieldFromId(db.collection("task-prompts"), "keyId", "[025] task-prompts.keyId=_id");

    // 4b. Unique-index swaps (guard against pre-existing collisions first).
    const skillRevisions = db.collection("skill-revisions");
    await assertNoCompositeDuplicates(skillRevisions, ["projectId", "ref"], "skill-revisions", "025");
    await dropIndexSafe(skillRevisions, { ref: 1 }, "skill-revisions", "025");
    await ensureUniqueIndexOrFallback(skillRevisions, { projectId: 1, ref: 1 }, "skill-revisions", "025");

    const taskPrompts = db.collection("task-prompts");
    await assertNoCompositeDuplicates(taskPrompts, ["projectId", "keyId"], "task-prompts", "025");
    await ensureUniqueIndexOrFallback(taskPrompts, { projectId: 1, keyId: 1 }, "task-prompts", "025");

    // 5. Scoping indexes on every scoped collection.
    for (const name of SCOPED_COLLECTIONS) {
      const col = db.collection(name);
      await ensureIndex(col, { projectId: 1 }, {}, name, "025");
      await ensureIndex(col, { projectId: 1, _id: 1 }, {}, name, "025");
    }

    console.log(`[025] Projects migration complete — initial project ${initialId}`);
  }

  async down(db: Db): Promise<void> {
    // Reverse the field backfills; index changes are log-only per convention.
    for (const name of SCOPED_COLLECTIONS) {
      await batchUpdate(
        db.collection(name),
        { projectId: { $exists: true } },
        { $unset: { projectId: "" } },
        `[025-down] unset ${name}.projectId`,
      );
    }
    await batchUpdate(
      db.collection("task-prompts"),
      { keyId: { $exists: true } },
      { $unset: { keyId: "" } },
      "[025-down] unset task-prompts.keyId",
    );
    console.log(
      "  [025-down] Skipping index drops and initial-project removal — remove manually if needed",
    );
  }
}
