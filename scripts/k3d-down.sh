#!/usr/bin/env bash
# =============================================================================
# k3d-down.sh — Tear down the local k3d cluster
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Read port offset (env var takes precedence over file)
if [ -z "${PORT_OFFSET:-}" ]; then
  PORT_OFFSET=0
  if [ -f ".port-offset" ]; then
    PORT_OFFSET=$(cat .port-offset | tr -d '[:space:]')
  fi
fi

CLUSTER_NAME="scope-${PORT_OFFSET:-0}"
REGISTRY_NAME="scope-${PORT_OFFSET:-0}-registry.localhost"

if ! k3d cluster list 2>/dev/null | grep -q "^$CLUSTER_NAME "; then
  echo "Cluster '$CLUSTER_NAME' does not exist."
  exit 0
fi

echo ">>> Deleting k3d cluster '$CLUSTER_NAME'..."
k3d cluster delete "$CLUSTER_NAME"

# Clean up the per-offset registry container. On podman the registry is created
# separately and persists after cluster deletion, so remove it explicitly. k3d
# lists/creates it with a 'k3d-' prefix; try the prefixed name first.
if k3d registry list 2>/dev/null | grep -q "$REGISTRY_NAME"; then
  echo ">>> Deleting registry 'k3d-${REGISTRY_NAME}'..."
  k3d registry delete "k3d-${REGISTRY_NAME}" 2>/dev/null \
    || k3d registry delete "$REGISTRY_NAME" 2>/dev/null \
    || echo "  ⚠ Could not delete registry (may already be gone)."
fi

echo ">>> Cluster '$CLUSTER_NAME' deleted."
