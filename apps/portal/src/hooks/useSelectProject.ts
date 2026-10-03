// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useProjectContext } from "@/contexts/ProjectContext";

/**
 * Query-key families that are **project-independent** and must survive a project
 * switch: the projects list itself (top-bar switcher, {@link ProjectGate}) and
 * the app-level feature flags (nav). Everything else is scoped — or, for the few
 * genuinely global families (agents, models, …), refetches identical data — so
 * it is safe to drop on switch. Matched against `queryKey[0]`.
 */
const GLOBAL_QUERY_KEY_ROOTS = new Set(["projects", "feature-flags"]);

/**
 * Returns a function that switches the active project **and** resets the scoped
 * TanStack Query cache.
 *
 * The API facade reads the selected project id from a module-level holder (see
 * {@link file://../lib/project-scope.ts}), so scoped query keys do **not**
 * include the project id. That means every cached scoped entry belongs to the
 * *previous* project after a switch.
 *
 * We **reset** (not merely invalidate) those entries. `invalidateQueries` only
 * marks queries stale and refetches in the background, so `stale-while-revalidate`
 * keeps the previous project's rows on screen during the refetch — and leaves the
 * stale data in cache for any scoped page that mounts right after we navigate,
 * which briefly renders the wrong project's data. `resetQueries` instead clears
 * the cached data to a hard loading state and refetches active queries under the
 * new scope, so scoped pages show a spinner and then the correct data. The two
 * project-independent families ({@link GLOBAL_QUERY_KEY_ROOTS}) are preserved so
 * the switcher and nav don't flash.
 *
 * Passing `undefined` clears the selection (used when e.g. the active project is
 * deleted).
 */
export function useSelectProject(): (projectId: string | undefined) => void {
  const { setSelectedProjectId } = useProjectContext();
  const queryClient = useQueryClient();

  return useCallback(
    (projectId: string | undefined) => {
      setSelectedProjectId(projectId);
      // Keys don't carry projectId, so every scoped entry now belongs to the
      // previous project. Reset (clear + refetch) rather than invalidate so no
      // stale rows flash before the new project's data arrives; keep the
      // project-independent shell queries intact.
      void queryClient.resetQueries({
        predicate: (query) =>
          !GLOBAL_QUERY_KEY_ROOTS.has(String(query.queryKey[0])),
      });
    },
    [setSelectedProjectId, queryClient],
  );
}
