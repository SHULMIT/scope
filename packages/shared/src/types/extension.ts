// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// --- VS Code Extension types ---

/**
 * How an extension was added to the internal extension list.
 * - "marketplace": imported from VS Code marketplace search results
 * - "manual": added manually by entering publisher + extension name
 */
export type ExtensionOrigin = "marketplace" | "manual";

/**
 * Extension document stored in MongoDB (`extensions` collection).
 *
 * A mutable reference to a VS Code extension.
 * The human slug is the extension identifier `{publisher}.{name}` (e.g. "ms-python.python"),
 * exposed as the public `id`. It is unique **per project**, not globally — the same slug may exist
 * in multiple projects. New rows use a random UUID `_id` and carry the slug in `slug`; legacy rows
 * (pre-migration 026) still have `_id === slug`, so lookups accept either.
 */
export interface ExtensionDocument {
  _id: string;                    // Random UUID for new rows; legacy rows: slug "{publisher}.{name}"
  slug: string;                   // Extension ID "{publisher}.{name}" — unique per project, exposed as public `id`
  projectId: string;              // FK → ProjectDocument._id (immutable scope)
  publisher: string;              // Publisher name (e.g. "ms-python")
  name: string;                   // Human-readable display name (e.g. "Python")
  description?: string;           // From marketplace
  origin: ExtensionOrigin;        // How the extension was added
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;               // Soft-delete timestamp
}

/**
 * Resolved extension configuration passed to workers at runtime.
 * Contains the minimal information needed for `code --install-extension`.
 */
export interface ExtensionConfig {
  id: string;                     // Extension ID: "{publisher}.{name}"
  version?: string;               // Specific version to install (latest if omitted)
}

/**
 * Unified search result returned by the extension search endpoint.
 * Merges results from the internal DB + VS Code marketplace.
 */
export interface ExtensionSearchResult {
  id: string;                     // Extension ID: "{publisher}.{name}"
  name: string;                   // Display name
  publisher: string;              // Publisher name
  description?: string;
  internal: boolean;              // true if already in our DB
  version?: string;               // Latest version from marketplace
}

/**
 * Parse an extension spec string ("id" or "id@version") into its components.
 * Used by the API and queue processor to handle version-pinned extensions.
 *
 * @example parseExtensionSpec("ms-python.python@2024.22.1") → { id: "ms-python.python", version: "2024.22.1" }
 * @example parseExtensionSpec("ms-python.python") → { id: "ms-python.python" }
 */
export function parseExtensionSpec(spec: string): ExtensionConfig {
  const atIndex = spec.lastIndexOf("@");
  if (atIndex > 0) {
    return { id: spec.substring(0, atIndex), version: spec.substring(atIndex + 1) };
  }
  return { id: spec };
}

/** Version info for a single extension version from the marketplace. */
export interface ExtensionVersionInfo {
  version: string;
  preRelease: boolean;
  lastUpdated: string;
}
