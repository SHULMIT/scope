// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: Per-project isolation for tagged-but-not-isolated catalogs.
 *
 * The Projects feature (migration 025) gave every scoped entity a `projectId`,
 * but four catalog families were still *keyed/deduped globally*, so the same
 * human slug/id could not exist in two projects (POST the same slug into a
 * second project → 409):
 *
 *   | Family          | Global key (pre-026)                    |
 *   |-----------------|-----------------------------------------|
 *   | skills          | `_id = "{source}/{skillName}"` (slug)   |
 *   | extensions      | `_id = "{publisher}.{name}"` (slug)     |
 *   | criteria        | unique `{ id }` index                    |
 *   | prompt-features | unique `{ id }` index                    |
 *
 * This migration makes each family unique **per project** instead of globally.
 * It is **additive and non-destructive**: no documents are deleted and no `_id`
 * is changed.
 *
 *   - **skills, extensions** — the route now keys new rows by `_id = randomUUID()`
 *     and carries the human slug in a `slug` field. We backfill `slug = _id` on
 *     existing rows (legacy `_id` IS the slug) and add a `{ projectId, slug }`
 *     unique index so the same slug can live in multiple projects.
 *   - **criteria, prompt-features** — `_id` stays an auto ObjectId. We swap the
 *     legacy global unique `{ id }` index for a per-project unique `{ projectId,
 *     id }` index (drop-then-create). The `{ projectId, id }` index also serves
 *     the scoped `getAll()` ORDER BY id on Cosmos.
 *
 * Cosmos DB caveat: unique indexes can't be created on an already-created
 * collection, and migration 002's global unique `{ id }` silently no-op'd on
 * Cosmos in the first place. We therefore reuse migration 025's Cosmos-safe
 * helpers (`ensureUniqueIndexOrFallback` degrades to a non-unique index on
 * Cosmos; per-project dedup is then enforced by the application). Real MongoDB
 * (local/CI) still gets true unique indexes.
 *
 * down(): unset the backfilled `slug` (skills/extensions). Index changes are
 * log-only per the repo convention (drop manually if needed).
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import { batchUpdate } from "../batch-update.js";
import {
  assertNoCompositeDuplicates,
  backfillFieldFromId,
  dropIndexSafe,
  ensureUniqueIndexOrFallback,
} from "../cosmos-index-helpers.js";

const TAG = "026";

/** Slug-keyed catalogs: `_id` was the slug; add a `slug` field + per-project unique index. */
const SLUG_COLLECTIONS = ["skills", "extensions"] as const;

/** Id-keyed catalogs: swap global unique `{id}` → per-project unique `{projectId, id}`. */
const ID_COLLECTIONS = ["criteria", "prompt-features"] as const;

export class IsolateCatalogsPerProject implements MigrationInterface {
  async up(db: Db): Promise<void> {
    // 1. skills, extensions — backfill slug = _id, then per-project unique slug.
    for (const name of SLUG_COLLECTIONS) {
      const col = db.collection(name);
      await backfillFieldFromId(col, "slug", `[${TAG}] ${name}.slug=_id`);
      await assertNoCompositeDuplicates(col, ["projectId", "slug"], name, TAG);
      await ensureUniqueIndexOrFallback(col, { projectId: 1, slug: 1 }, name, TAG);
    }

    // 2. criteria, prompt-features — swap global unique {id} → unique {projectId, id}.
    //    (projectId was backfilled by migration 025, so no field backfill here.)
    for (const name of ID_COLLECTIONS) {
      const col = db.collection(name);
      await assertNoCompositeDuplicates(col, ["projectId", "id"], name, TAG);
      // Legacy global unique index from migration 002. Drops on real MongoDB;
      // best-effort no-op on Cosmos (where it silently never materialised).
      await dropIndexSafe(col, { id: 1 }, name, TAG);
      await ensureUniqueIndexOrFallback(col, { projectId: 1, id: 1 }, name, TAG);
    }

    console.log(`[${TAG}] Per-project catalog isolation complete`);
  }

  async down(db: Db): Promise<void> {
    // Reverse only the additive field backfill; index changes are log-only.
    for (const name of SLUG_COLLECTIONS) {
      await batchUpdate(
        db.collection(name),
        { slug: { $exists: true } },
        { $unset: { slug: "" } },
        `[${TAG}-down] unset ${name}.slug`,
      );
    }
    console.log(
      `  [${TAG}-down] Skipping index changes — drop {projectId,slug}/{projectId,id} manually if needed`,
    );
  }
}
