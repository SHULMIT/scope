// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Migration: per-project unique index on `mcp-secrets`.
 *
 * Migration 025 gave every scoped entity a `projectId`, 026 isolated four catalog
 * families per project, and 027 extended the UUID `_id` + reference-key identity
 * model to mcp-servers and profile-versions. This migration closes the same gap
 * for **mcp-secrets**: the collection's uniqueness must be scoped per project.
 *
 * The per-project data-organization PR swapped the `mcp-secrets` unique index in
 * token-manager's startup code from the legacy global-unique `{ mcpId, name }`
 * to `{ projectId, mcpId, name }`, but `createIndex` only *adds* the new index on
 * existing deploys — it never drops the old one. So on int/prod the legacy
 * global-unique `{ mcpId, name }` survives and still rejects the same
 * `(mcpId, name)` across two different projects, defeating per-project isolation.
 *
 * This migration reconciles the index the same way migration 026 reconciles the
 * `criteria`/`prompt-features` id-keyed catalogs (its ID_COLLECTIONS loop):
 *
 *   1. `assertNoCompositeDuplicates(["projectId","mcpId","name"])` — pre-flight
 *      guard so a genuine cross-project collision surfaces loudly instead of the
 *      unique-index build failing halfway.
 *   2. Drop the legacy global-unique `{ mcpId, name }`. Real MongoDB drops it;
 *      best-effort no-op on Cosmos (where the unique index silently never
 *      materialised) and on fresh envs.
 *   3. (Re)create the per-project unique `{ projectId, mcpId, name }`.
 *
 * No field backfill is needed for the index to build: the legacy `{ mcpId, name }`
 * was globally unique, so `{ projectId, mcpId, name }` is unique regardless of
 * whether `projectId` is populated (legacy rows collapse to `{ null, mcpId, name }`,
 * which is still unique). token-manager still owns the `projectId` value backfill
 * at startup; this migration only owns the index reconciliation.
 *
 * Cosmos DB caveat: reuse migration 025/026's Cosmos-safe helpers
 * (`ensureUniqueIndexOrFallback` degrades to a non-unique index on Cosmos; app-
 * level scoped dup-checks in the token-manager routes enforce per-project
 * uniqueness there). Real MongoDB (local/CI) gets a true unique index.
 *
 * down(): log-only per the repo convention (026/027). The legacy global-unique
 * index is deliberately NOT recreated — doing so would reintroduce the bug and
 * could fail against a now-multi-project populated collection.
 */

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";
import {
  assertNoCompositeDuplicates,
  dropIndexSafe,
  ensureUniqueIndexOrFallback,
} from "../cosmos-index-helpers.js";

const TAG = "028";

const COLLECTION = "mcp-secrets";

export class IsolateMcpSecretsPerProject implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const col = db.collection(COLLECTION);

    // Guard: fail loudly on a genuine cross-project collision before we rely on
    // the unique index to enforce it.
    await assertNoCompositeDuplicates(col, ["projectId", "mcpId", "name"], COLLECTION, TAG);

    // Legacy global-unique index from token-manager startup (pre per-project PR).
    // Drops on real MongoDB; best-effort no-op on Cosmos / fresh envs.
    await dropIndexSafe(col, { mcpId: 1, name: 1 }, COLLECTION, TAG);

    // Per-project unique index (idempotent — token-manager also creates it at
    // startup; this makes it authoritative and Cosmos-safe).
    await ensureUniqueIndexOrFallback(
      col,
      { projectId: 1, mcpId: 1, name: 1 },
      COLLECTION,
      TAG,
    );

    console.log(`[${TAG}] mcp-secrets per-project unique index reconciled`);
  }

  async down(_db: Db): Promise<void> {
    // Index changes are log-only per repo convention. Do NOT recreate the legacy
    // global-unique {mcpId,name} index — it would reintroduce the cross-project
    // collision bug and could fail on a now-multi-project populated collection.
    console.log(
      `  [${TAG}-down] Skipping index changes — drop {projectId,mcpId,name} manually if needed`,
    );
  }
}
