// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Portal-side holder for the currently selected project id.
 *
 * The Portal has **no "default" project**: scoped Scope API calls must carry an
 * explicit `?projectId=`. React components select and read the active project
 * through {@link file://../contexts/ProjectContext.tsx ProjectContext}, but the
 * non-hook API facade ({@link file://./api.ts}) also needs the id when it builds
 * a request. So the context mirrors every change into this module-level holder,
 * and the facade's `request()` reads it here. This mirrors the CLI's
 * `resolveProjectId()` seam ({@link file://../../../cli/src/utils/config.ts}).
 *
 * The holder is seeded from `localStorage` at module load so the very first
 * scoped `request()` — which can fire before the provider's effects run — still
 * sees the persisted selection. The {@link ProjectProvider} remains the single
 * writer of `localStorage`; this module only reads it once for that early window.
 */

/** `localStorage` key holding the selected project id. Shared with the context. */
export const PROJECT_STORAGE_KEY = "scope:selectedProject";

function readStored(): string | undefined {
  try {
    const raw = localStorage.getItem(PROJECT_STORAGE_KEY);
    const trimmed = raw?.trim();
    return trimmed ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

let selectedProjectId: string | undefined = readStored();

/** Current selected project id, or `undefined` when none is selected. */
export function getSelectedProjectId(): string | undefined {
  return selectedProjectId;
}

/**
 * Update the in-memory holder. Called by {@link ProjectProvider} on every
 * selection change (and once on mount) so the API facade stays in sync. Blank
 * ids are normalized to `undefined`.
 */
export function setSelectedProjectIdHolder(id: string | undefined): void {
  selectedProjectId = id?.trim() || undefined;
}

/**
 * Thrown by the API facade when a **scoped** call is attempted while no project
 * is selected. Surfaces as a clear, actionable error instead of a silent
 * cross-project or default fetch (there is no default project). The route-level
 * scope guard normally prevents scoped pages from firing these at all; this is
 * the defense-in-depth backstop.
 */
export class ProjectRequiredError extends Error {
  constructor(
    message = "Select a project to continue — no project is currently selected.",
  ) {
    super(message);
    this.name = "ProjectRequiredError";
  }
}
