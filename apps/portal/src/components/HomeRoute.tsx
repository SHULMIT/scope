// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";

import { ProjectFirstRunScreen } from "@/components/ProjectGate";
import { useProjectContext } from "@/contexts/ProjectContext";
import { useSelectProject } from "@/hooks/useSelectProject";

/**
 * The unscoped app **home** at `/`.
 *
 * Landing here always **de-scopes**: reaching the root by any means (the Scope
 * logo, a typed URL, the back button, a bookmark) clears the active project and
 * shows the project picker. There is no default project, so `/` is the picker —
 * not a redirect to a scoped page. Centralizing the reset in the route (rather
 * than the logo's click handler) makes every path to `/` behave identically and
 * needs no open-in-new-tab special-casing.
 *
 * On arrival the selection still reflects the *previous* scope, so we ignore
 * `hasProject` until our clear effect has run (tracked by `cleared`); otherwise a
 * stale selection would bounce us to `/statistics` before we reset. Once the user
 * actively picks a project from the picker, `hasProject` flips back on and we
 * forward them into the scoped app.
 */
export function HomeRoute() {
  const selectProject = useSelectProject();
  const { hasProject } = useProjectContext();
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    // Clear the inherited selection (and reset scoped query caches) on entry.
    // `selectProject` is stable (ProjectContext's setter + queryClient are), so
    // this runs once and never re-clears a project the user just picked.
    selectProject(undefined);
    setCleared(true);
  }, [selectProject]);

  // A selection appearing *after* we've cleared means the user chose one in the
  // picker, so send them to the scoped landing. Before clearing, the stale
  // selection must not trigger this redirect.
  if (cleared && hasProject) return <Navigate to="/statistics" replace />;

  return <ProjectFirstRunScreen />;
}
