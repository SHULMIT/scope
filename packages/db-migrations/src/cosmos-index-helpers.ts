// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Cosmos-safe index & backfill helpers shared across migrations.
 *
 * Azure Cosmos DB for MongoDB (RU-based) has several index quirks that a plain
 * `createIndex`/`dropIndex` does not handle gracefully:
 *   - a **unique** index can only be created while the collection is empty / at
 *     creation time; `createIndex(..., {unique:true})` on an already-created
 *     collection fails with code 67 (populated) or HTTP 403 "unique index cannot
 *     be modified" (empty-but-created);
 *   - `createIndex` on an existing index reports code 85/86/68 instead of a
 *     silent no-op;
 *   - `dropIndex` of a missing index reports code 26/27.
 *
 * These helpers centralise that handling so every migration behaves identically
 * on both real MongoDB (local/CI) and Cosmos. Originally written for migration
 * 025 and extracted here so later migrations (026+) reuse the exact same logic.
 */

import type { Collection } from "mongodb";
import { BATCH_SIZE, INTER_BATCH_DELAY_MS, getRetryAfterMs, sleep } from "./batch-update.js";

/** Index-already-exists error codes (Mongo + Cosmos MongoDB API). */
const ALREADY_EXISTS_CODES = new Set([85, 86, 68]);
/** Index/namespace-not-found error codes. */
const NOT_FOUND_CODES = new Set([26, 27]);
/**
 * Azure Cosmos DB (RU-based) refuses to create/modify a unique index on an
 * *already-created* collection. This surfaces two different ways depending on
 * collection state:
 *   - **Populated** collection → code 67 (`CannotCreateIndex`, "Cannot create
 *     unique index when collection contains documents").
 *   - **Empty but already-created** collection → HTTP 403 Forbidden (mapped to
 *     Mongo error code 13) with the message "The unique index cannot be
 *     modified. To change the unique index, remove the collection and re-create
 *     a new one." — because Cosmos fixes a collection's unique-key policy at
 *     creation time and will not alter it afterwards, even when empty.
 * Real MongoDB has neither restriction.
 */
const CANNOT_CREATE_UNIQUE_ON_POPULATED = 67;

/**
 * True when `err` is Cosmos refusing a unique index because the collection
 * already exists (populated → code 67, or empty-but-created → 403 "unique index
 * cannot be modified"). Matched by message for the 403 case so a genuine
 * authorization failure (also code 13) still surfaces instead of silently
 * degrading to a non-unique index.
 */
export function isCosmosUniqueIndexUnsupported(err: any): boolean {
  if (err?.code === CANNOT_CREATE_UNIQUE_ON_POPULATED) return true;
  return /unique index cannot be modified/i.test(String(err?.message ?? ""));
}

/** Create an index, tolerating "already exists" but surfacing real failures. */
export async function ensureIndex(
  col: Collection,
  key: Record<string, 1 | -1>,
  options: { unique?: boolean } = {},
  label = "",
  tag = "",
): Promise<void> {
  try {
    const name = await col.createIndex(key, options);
    console.log(`  [${tag}] created index ${name} ${JSON.stringify(key)} on ${label}`);
  } catch (err: any) {
    if (ALREADY_EXISTS_CODES.has(err?.code)) {
      console.log(`  [${tag}] index ${JSON.stringify(key)} on ${label} already exists`);
      return;
    }
    throw err;
  }
}

/** Drop an index by key spec, tolerating "not found". Best-effort. */
export async function dropIndexSafe(
  col: Collection,
  key: Record<string, 1 | -1>,
  label = "",
  tag = "",
): Promise<void> {
  try {
    await col.dropIndex(key as any);
    console.log(`  [${tag}] dropped index ${JSON.stringify(key)} on ${label}`);
  } catch (err: any) {
    if (NOT_FOUND_CODES.has(err?.code)) {
      console.log(`  [${tag}] index ${JSON.stringify(key)} on ${label} not present (skip drop)`);
      return;
    }
    console.log(
      `  [${tag}] could not drop index ${JSON.stringify(key)} on ${label}: ${err?.message ?? err}`,
    );
  }
}

/**
 * Create a UNIQUE index, degrading gracefully on Azure Cosmos DB for MongoDB.
 *
 * On real MongoDB the unique index is created and enforced. On Cosmos (RU-based)
 * a unique index can only be created while the collection is empty / at creation
 * time, so `createIndex(..., {unique:true})` on an already-created collection
 * fails — code 67 when populated, or HTTP 403 "unique index cannot be modified"
 * when empty-but-created. In either case we fall back to a **non-unique** index
 * on the same key (kept for lookup/ORDER BY performance) and rely on the
 * application-level `findOrCreate`/scoped dup-checks for per-project dedup —
 * which is already how these collections behave on Cosmos today. A pre-flight
 * `assertNoCompositeDuplicates` guards data quality regardless of backend, and
 * genuine duplicate-key errors (code 11000, real MongoDB) are surfaced.
 */
export async function ensureUniqueIndexOrFallback(
  col: Collection,
  key: Record<string, 1 | -1>,
  label: string,
  tag = "",
): Promise<void> {
  try {
    const name = await col.createIndex(key, { unique: true });
    console.log(`  [${tag}] created UNIQUE index ${name} ${JSON.stringify(key)} on ${label}`);
    return;
  } catch (err: any) {
    if (ALREADY_EXISTS_CODES.has(err?.code)) {
      console.log(`  [${tag}] unique index ${JSON.stringify(key)} on ${label} already exists`);
      return;
    }
    if (!isCosmosUniqueIndexUnsupported(err)) {
      throw err;
    }
    console.warn(
      `  [${tag}] ⚠ ${label}: Cosmos DB cannot create a unique index on an ` +
        `already-created collection (code ${err?.code}: ${String(err?.message ?? "").slice(0, 80)}). ` +
        `Falling back to a NON-unique ${JSON.stringify(key)} index; per-project ` +
        `uniqueness is enforced by the application (findOrCreate / scoped dup-check).`,
    );
  }
  // Fallback path (Cosmos): create the same key as a non-unique lookup index.
  await ensureIndex(col, key, {}, label, tag);
}

/**
 * Throw if any composite key `fields` occurs more than once — a pre-existing
 * collision would make a unique index on those fields fail to build (esp. on
 * Cosmos). Called before creating a composite unique index.
 */
export async function assertNoCompositeDuplicates(
  col: Collection,
  fields: string[],
  label: string,
  tag = "",
): Promise<void> {
  const groupId: Record<string, string> = {};
  for (const f of fields) groupId[f] = `$${f}`;
  const dups = await col
    .aggregate([
      { $group: { _id: groupId, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 1 },
    ])
    .toArray();
  if (dups.length > 0) {
    throw new Error(
      `[${tag}] ${label}: found a duplicate ${JSON.stringify(fields)} — resolve before creating the unique index`,
    );
  }
}

/**
 * Copy each document's `_id` into a new `field`, RU-paced and 429-retrying.
 * Only touches rows where `field` is absent (idempotent). Used to backfill
 * content-addressed keys onto a dedicated field before the `_id` scheme changes
 * (e.g. task-prompts `keyId`, skills/extensions `slug`).
 */
export async function backfillFieldFromId(
  col: Collection,
  field: string,
  label: string,
): Promise<number> {
  const ids: unknown[] = [];
  const cursor = col.find({ [field]: { $exists: false } }, { projection: { _id: 1 } });
  for await (const doc of cursor) ids.push(doc._id);

  if (ids.length === 0) {
    console.log(`  ${label}: 0 documents`);
    return 0;
  }
  console.log(
    `  ${label}: ${ids.length} documents in ${Math.ceil(ids.length / BATCH_SIZE)} batches`,
  );

  let total = 0;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    if (i > 0) await sleep(INTER_BATCH_DELAY_MS);

    let retries = 0;
    const maxRetries = 10;
    while (retries < maxRetries) {
      try {
        const result = await col.bulkWrite(
          batch.map((id) => ({
            updateOne: { filter: { _id: id as any }, update: { $set: { [field]: id } } },
          })),
        );
        total += result.modifiedCount ?? 0;
        break;
      } catch (err: any) {
        if (err?.code === 16500 && retries < maxRetries - 1) {
          const delay = Math.max(getRetryAfterMs(err), 500);
          console.log(`  ${label}: 429, retry ${retries + 1}, waiting ${delay}ms...`);
          await sleep(delay);
          retries++;
        } else {
          throw err;
        }
      }
    }
  }
  console.log(`  ${label}: ${total} documents updated`);
  return total;
}
