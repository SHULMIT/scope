// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Opaque UUID `_id` + human reference key for MCP servers and profile
 * versions, plus deletion of the dead prompt-feature-extractions collection.
 *
 * Migration 025 gave every scoped entity a `projectId`, and 026 isolated four
 * catalog families per project. This migration extends the same "opaque UUID
 * `_id` + separate reference key + project-scoped resolution" identity model to
 * two more entities and removes one dead collection:
 *
 *   | Entity            | `_id` (pre-027)                | Reference key added |
 *   |-------------------|--------------------------------|---------------------|
 *   | mcp-servers       | slug ("my-search-server")      | `slug`              |
 *   | profile-versions  | composite "<profileId>@<ver>"  | `ref`               |
 *
 * It is **additive and non-destructive** for the two carried entities: no `_id`
 * is rewritten. Legacy rows keep their slug/composite `_id`; only **new** rows
 * (minted by the API after this ships) get a UUID `_id`. We backfill the human
 * key into its own field so lookups can switch from `{_id: ref}` to
 * `{projectId, <refKey>: ref}` uniformly across old and new rows.
 *
 *   - **mcp-servers** — backfill `slug = _id` (legacy `_id` IS the slug); add a
 *     `{projectId, slug}` unique index so the same slug can live in multiple
 *     projects (removes the cross-project 409).
 *   - **profile-versions** — backfill `ref = _id` (legacy `_id` IS the
 *     "<profileId>@<version>" composite); add a `{projectId, ref}` unique index
 *     (a guardrail/ordering index — the composite is already globally unique
 *     because profileId is a UUID). Ensure `{profileId, version}` remains for the
 *     latest-version lookup.
 *
 * **prompt-feature-extractions** is DROPPED. It is confirmed dead code:
 * `taskTextHash` is never computed and the collection is never read/written at
 * runtime (real feature caching lives on TaskPrompt, already project-scoped by
 * 025). Guarded so it is a no-op when the collection is already absent (fresh
 * envs) — migration 001 only ever *read* it and tolerates its absence.
 *
 * Cosmos DB caveat: reuse migration 025/026's Cosmos-safe helpers
 * (`ensureUniqueIndexOrFallback` degrades to a non-unique index on Cosmos; app-
 * level scoped dup-checks enforce per-project uniqueness there). Real MongoDB
 * (local/CI) gets true unique indexes.
 *
 * down(): unset the backfilled `slug`/`ref`. Index changes and the dropped
 * collection are log-only per the repo convention (not recreated).
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import { batchUpdate } from "../batch-update.js";
import {
  assertNoCompositeDuplicates,
  backfillFieldFromId,
  ensureIndex,
  ensureUniqueIndexOrFallback,
} from "../cosmos-index-helpers.js";

const TAG = "027";

const DEAD_COLLECTION = "prompt-feature-extractions";

export class UuidKeysMcpProfileVersions implements MigrationInterface {
  async up(db: Db): Promise<void> {
    // 1. mcp-servers — backfill slug = _id, then per-project unique slug.
    {
      const col = db.collection("mcp-servers");
      await backfillFieldFromId(col, "slug", `[${TAG}] mcp-servers.slug=_id`);
      await assertNoCompositeDuplicates(col, ["projectId", "slug"], "mcp-servers", TAG);
      await ensureUniqueIndexOrFallback(col, { projectId: 1, slug: 1 }, "mcp-servers", TAG);
    }

    // 2. profile-versions — backfill ref = _id (the "<profileId>@<version>" composite),
    //    add per-project unique {projectId, ref}, and keep {profileId, version} for
    //    latest-version lookups.
    {
      const col = db.collection("profile-versions");
      await backfillFieldFromId(col, "ref", `[${TAG}] profile-versions.ref=_id`);
      await assertNoCompositeDuplicates(col, ["projectId", "ref"], "profile-versions", TAG);
      await ensureUniqueIndexOrFallback(col, { projectId: 1, ref: 1 }, "profile-versions", TAG);
      // Retain the latest-version lookup index (idempotent if it already exists).
      await ensureIndex(col, { profileId: 1, version: 1 }, {}, "profile-versions", TAG);
    }

    // 3. prompt-feature-extractions — DROP the dead collection (guarded no-op if absent).
    try {
      await db.dropCollection(DEAD_COLLECTION);
      console.log(`  [${TAG}] dropped dead collection ${DEAD_COLLECTION}`);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (err?.codeName === "NamespaceNotFound" || /ns not found|namespace not found/i.test(msg)) {
        console.log(`  [${TAG}] collection ${DEAD_COLLECTION} not present (skip drop)`);
      } else {
        console.log(`  [${TAG}] could not drop ${DEAD_COLLECTION}: ${msg}`);
      }
    }

    console.log(`[${TAG}] UUID-key identity for mcp-servers/profile-versions complete`);
  }

  async down(db: Db): Promise<void> {
    // Reverse only the additive field backfills; index changes are log-only and the
    // dropped dead collection is not recreated.
    await batchUpdate(
      db.collection("mcp-servers"),
      { slug: { $exists: true } },
      { $unset: { slug: "" } },
      `[${TAG}-down] unset mcp-servers.slug`,
    );
    await batchUpdate(
      db.collection("profile-versions"),
      { ref: { $exists: true } },
      { $unset: { ref: "" } },
      `[${TAG}-down] unset profile-versions.ref`,
    );
    console.log(
      `  [${TAG}-down] Skipping index changes and ${DEAD_COLLECTION} recreation — ` +
        `drop {projectId,slug}/{projectId,ref} manually if needed`,
    );
  }
}
