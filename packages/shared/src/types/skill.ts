// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// --- Skill types ---

/**
 * How a skill was added to the internal library.
 *
 * - `"manual"` — imported via the Portal discovery wizard (scanning a GitHub repo)
 *   or the CLI `skill import` command. The user explicitly provided the GitHub
 *   repository and skill name. Content is always fetched directly from GitHub.
 *
 * - `"skills-sh"` — imported from skills.sh search results. The user found the
 *   skill through the skills.sh external registry (a search index over public
 *   GitHub repos). Content is still fetched from GitHub — skills.sh only provides
 *   discovery/metadata, not the skill content itself.
 *
 * In both cases, GitHub is the source of truth for skill content.
 */
export type SkillOrigin = "skills-sh" | "manual";

/**
 * Skill reference document stored in MongoDB (`skills` collection).
 *
 * A mutable pointer to a skill in a GitHub repository. Represents an "imported"
 * skill in Scope's internal library. Regardless of origin (manual or skills-sh),
 * the skill content is always resolved from the GitHub repository specified by `source`.
 *
 * The human slug is `{source}/{skillName}` (e.g. "vercel-labs/agent-skills/vercel-react-best-practices"),
 * exposed as the public `id`. It is unique **per project**, not globally — the same slug may exist in
 * multiple projects. New rows use a random UUID `_id` and carry the slug in `slug`; legacy rows
 * (pre-migration 026) still have `_id === slug`, so lookups accept either.
 */
export interface SkillDocument {
  _id: string;                    // Random UUID for new rows; legacy rows: slug "{source}/{skillName}"
  slug: string;                   // Human slug "{source}/{skillName}" — unique per project, exposed as public `id`
  projectId: string;              // FK → ProjectDocument._id (immutable scope)
  source: string;                 // GitHub repo (e.g. "vercel-labs/agent-skills")
  skillName: string;              // Skill name within the repo (e.g. "vercel-react-best-practices")
  name: string;                   // Human-readable display name (from SKILL.md or user input)
  description?: string;           // From SKILL.md frontmatter or skills.sh
  origin: SkillOrigin;            // How the skill was added
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;               // Soft-delete timestamp
}

/**
 * Skill revision document stored in MongoDB (`skill-revisions` collection).
 *
 * An **immutable** versioned snapshot of a skill, captured at run submission time.
 * Content-addressed: `_id` is `UUIDv5(ref)` where `ref` is `{source}/{skillName}@{commitHash}`.
 *
 * Follows the Agent Skills Specification: https://agentskills.io/specification
 */
export interface SkillRevisionDocument {
  _id: string;                    // UUIDv5 computed from `ref`
  projectId: string;              // FK → ProjectDocument._id (immutable scope; per-project copy)
  ref: string;                    // Human-readable ref: "{source}/{skillName}@{commitHash}"
  source: string;                 // GitHub repo (e.g. "vercel-labs/agent-skills")
  skillName: string;              // Skill name (matches parent directory name per spec)
  skillPath: string;              // Path within repo (e.g. "skills/vercel-react-best-practices")
  commitHash: string;             // Latest commit touching the skill directory
  commitTimestamp: Date;          // That commit's timestamp

  // Spec frontmatter fields (https://agentskills.io/specification)
  name: string;                   // Required: 1-64 chars, lowercase alphanumeric + hyphens
  description: string;            // Required: 1-1024 chars
  license?: string;               // Optional: license name or reference
  compatibility?: string;         // Optional: 1-500 chars, environment requirements
  allowedTools?: string;          // Optional: space-delimited pre-approved tools (experimental)
  metadata?: Record<string, string>; // Optional: arbitrary key-value pairs

  // Content
  content: string;                // SKILL.md markdown body (after frontmatter)
  archiveUrl: string;             // Blob storage URL to the skill directory tar.gz

  // Housekeeping
  validationWarnings?: string[];    // Non-blocking validation warnings (e.g. name-dir mismatch)
  resolvedAt: Date;               // When the skill was fetched/resolved
  createdAt: Date;
}

/**
 * Resolved skill configuration passed to workers at runtime.
 * Contains the minimal information needed to download and install the skill.
 */
export interface SkillConfig {
  ref: string;                    // Revision ref (e.g. "owner/repo/skill@commitHash")
  name: string;
  description: string;
  content: string;                // SKILL.md markdown body
}

/**
 * Unified search result returned by the skills search endpoint.
 * Merges results from the internal DB and the external skills.sh registry.
 *
 * skills.sh (https://skills.sh) is an external search index over publicly
 * available Agent Skills in GitHub repos. It provides discovery/metadata only —
 * actual skill content is always fetched from GitHub during import.
 */
export interface SkillSearchResult {
  id: string;                     // Slug: "{source}/{skillName}"
  name: string;                   // Skill name
  source: string;                 // GitHub repo
  description?: string;
  internal: boolean;              // true if already in our DB
  installs?: number;              // Install count from skills.sh (external only)
}

/**
 * A skill discovered by enumerating the well-known directories of a GitHub repo.
 * Returned by the skill discovery endpoint to power the multi-skill import wizard.
 */
export interface SkillDiscoveryResult {
  skillName: string;              // Directory name (last path segment)
  skillPath: string;              // Full path within the repo
  name?: string;                  // Display name from SKILL.md frontmatter (best-effort)
  description?: string;           // Description from SKILL.md frontmatter (best-effort)
  // Library-status enrichment (set by the API route, not the resolver):
  existsInLibrary?: boolean;      // True if a SkillDocument with this source+skillName exists
  currentRevisionCommitSha?: string; // commitHash of the most recently stored SkillRevisionDocument
  latestUpstreamCommitSha?: string;  // commitSha of the latest commit touching skillPath upstream
  updateAvailable?: boolean;      // existsInLibrary && currentRevisionCommitSha !== latestUpstreamCommitSha
  lastImportedAt?: string;        // ISO timestamp of the most recent revision (if existsInLibrary)
}
