// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// --- Codebase types ---

/**
 * The source a codebase revision is captured from.
 * - "git": a registered GitHub repository, snapshotted at a resolved commit.
 * - "archive": a user-uploaded archive (tar.gz/zip), normalized to a tar.gz.
 */
export type CodebaseSourceType = "git" | "archive";

/**
 * Codebase reference document stored in MongoDB (`codebases` collection).
 *
 * A **mutable** pointer/metadata record for a first-class codebase entity.
 * Each codebase owns an immutable, incremental revision history
 * (`codebase-revisions` collection). The `_id` is a fresh UUID; the human
 * `slug` is used in CLI/URLs/refs.
 */
export interface CodebaseDocument {
  _id: string;                    // Fresh UUID
  projectId: string;              // FK → ProjectDocument._id (immutable scope)
  slug: string;                   // Unique, URL-safe identifier (derived from name)
  name: string;                   // Human-readable display name
  description?: string;
  sourceType: CodebaseSourceType;
  source?: string;                // Git only: GitHub repo "owner/repo"
  defaultBranch?: string;         // Git only: branch hint for "resolve latest"
  /**
   * Monotonically increasing counter used to assign each new revision's
   * `revisionNumber`. Atomically `$inc`-ed via `findOneAndUpdate` so concurrent
   * revision creates receive distinct, gap-free numbers.
   */
  revisionCounter: number;
  latestRevisionId?: string;      // Convenience pointer to the newest revision
  latestRevisionNumber?: number;  // revisionNumber of latestRevisionId; guards the pointer against stale concurrent writes
  creator?: string;               // Who created it (provenance)
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;               // Soft-delete timestamp
}

/**
 * Codebase revision document stored in MongoDB (`codebase-revisions` collection).
 *
 * An **immutable, purely incremental** snapshot of a codebase. Revisions are
 * NOT content-addressed: every archive upload and every git resolution always
 * inserts a new revision with the next `revisionNumber`. Existing revisions are
 * never mutated. `resolvedCommitSha` (git) and `contentSha256` (archive) are
 * kept only as provenance — they are not part of the ref or `_id`.
 *
 * The canonical ref is `"{slug}@r{revisionNumber}"` for both source types.
 */
export interface CodebaseRevisionDocument {
  _id: string;                    // Fresh UUID (one per revision)
  codebaseId: string;             // FK → CodebaseDocument._id
  projectId: string;              // FK → ProjectDocument._id (denormalized from codebase)
  slug: string;                   // Denormalized parent slug (for ref building/lookup)
  revisionNumber: number;         // Sequential per codebase (1,2,3…)
  ref: string;                    // Canonical display ref: "{slug}@r{revisionNumber}"
  sourceType: CodebaseSourceType;

  // Git provenance (sourceType === "git")
  source?: string;                // GitHub repo "owner/repo"
  requestedRef?: string;          // Branch/tag/"latest" that was requested
  resolvedCommitSha?: string;     // The exact commit SHA snapshotted
  commitTimestamp?: Date;         // That commit's timestamp

  // Archive provenance (sourceType === "archive")
  originalFilename?: string;      // Uploaded file name
  contentSha256?: string;         // SHA-256 of the uploaded archive bytes

  // Content
  archiveUrl: string;             // Blob storage URL to the normalized tar.gz

  // Extraction/prep metadata
  sizeBytes?: number;             // Archive size in bytes
  fileCount?: number;             // Number of files in the snapshot

  // Housekeeping
  creator?: string;               // Who created the revision (provenance)
  resolvedAt: Date;               // When the snapshot was fetched/resolved
  createdAt: Date;
  /**
   * Soft-delete timestamp. Set when the parent codebase is soft-deleted
   * (cascade). Revisions are never hard-deleted in normal operation so that
   * runs referencing this revision keep resolving; lookups by id/ref/number
   * intentionally ignore this flag, while listings exclude soft-deleted.
   */
  deletedAt?: Date;
}

/**
 * Resolved codebase configuration passed to workers at runtime.
 * Contains the minimal information needed to download and seed the codebase
 * into a fresh workspace before the agent starts.
 */
export interface CodebaseConfig {
  ref: string;                    // Revision ref ("{slug}@r{revisionNumber}")
  codebaseId: string;
  revisionId: string;             // CodebaseRevisionDocument._id
  sourceType: CodebaseSourceType;
  archiveUrl: string;             // Blob URL (downloaded via the API proxy)
}
