// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection } from "mongodb";
import type { ExtensionDocument } from "shared";

/**
 * Validate that every extension slug in `bareIds` exists in the project.
 *
 * Extensions are isolated per project: new rows key `_id` to a UUID and carry
 * the human slug (`"{publisher}.{name}"`) in `slug`; legacy rows (pre-migration
 * 026) still have `_id === slug`. We match either so both resolve within the
 * project, exactly mirroring the skills resolution path.
 *
 * Returns the list of slugs that were not found (empty ⇒ all present).
 */
export async function findMissingExtensionSlugs(
  bareIds: string[],
  extensionCollection: Collection<ExtensionDocument>,
  projectId: string,
): Promise<string[]> {
  if (bareIds.length === 0) return [];
  const existingExtensions = await extensionCollection
    .find({
      projectId,
      deletedAt: { $exists: false },
      $or: [{ slug: { $in: bareIds } }, { _id: { $in: bareIds } }],
    })
    .toArray();
  const existing = new Set(existingExtensions.map((e: ExtensionDocument) => e.slug ?? e._id));
  return bareIds.filter((id) => !existing.has(id));
}
