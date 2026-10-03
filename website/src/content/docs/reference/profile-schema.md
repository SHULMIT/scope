---
title: Profile schema
description: Field reference for Scope profiles and profile versions.
---

A **profile** has a stable identity and a series of **immutable
versions**. Each version captures the full agent runtime
configuration.

See [Defining profiles](/guides/defining-profiles/) for the conceptual
overview.

## Profile (identity)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | Stable identifier, used in API URLs and run records. |
| `name` | string | yes | Human-readable name. |
| `description` | string | no | Free-form description. |

The identity object is **mutable**: you can rename a profile or update
its description without affecting past runs.

## Profile version

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | auto | Version identifier, returned on creation. |
| `profileId` | string | auto | Parent profile ID. |
| `workerType` | string | yes | One of the supported worker IDs — see [Workers reference](/reference/workers/). |
| `model` | string | yes | Model identifier accepted by the chosen worker. |
| `agentVersion` | string | no | Pinned agent version (worker-specific). Recommended for benchmarks. |
| `mcpServers` | string[] | no | List of MCP server slugs registered in your deployment. |
| `skillRevisions` | string[] | no | Copilot skill references. Unpinned paths are resolved to commits at version-creation time. |
| `createdAt` | string (ISO-8601) | auto | Creation timestamp. |

Versions are **immutable** once created. To change anything, create a
new version.

## Field details

### `workerType`

One of:

- `coder-acp-copilot`
- `coder-acp-claude-code`

See [Coding agents & capabilities](/reference/workers/).

### `model`

The set of valid model identifiers depends on the worker. Use the
Portal's profile editor to see the current list, or check the worker's
section in the Workers reference.

### `agentVersion`

Pin the version of the underlying agent (Copilot extension version,
Claude Code version, etc.) so that re-running a profile version next
month exercises the *same* agent code.

### `mcpServers`

Slugs reference MCP servers already registered in your Scope
deployment. The Portal's **MCP servers** page lists what's available.

### `skillRevisions`

Form: `github/<owner>/<repo>/<skill-path>` or
`github/<owner>/<repo>/<skill-path>@<commit>`. Unpinned references are
resolved to a commit hash at version-creation time and stored in the
pinned form. Skills only apply to Copilot-based agents.

### `extensions`

Form: `<publisher>.<extensionId>` or
`<publisher>.<extensionId>@<version>`. Unpinned IDs are resolved to
the latest stable Marketplace version at version-creation time.

The two CLI-based agents reject `extensions` with HTTP 400. Only
VS Code Copilot accepts them.

## Example

```json
{
  "id": "vscode-python-azure",
  "name": "VS Code + Python + Azure",
  "description": "VS Code Copilot with Python tooling and Azure skill"
}
```

```json
{
  "model": "gpt-4o",
  "agentVersion": "1.95.2",
  "mcpServers": ["filesystem", "github"],
  "skillRevisions": ["github/vercel-labs/agent-skills/azure"],
  "extensions": ["ms-python.python", "esbenp.prettier-vscode"]
}
```

## See also

- [Defining profiles](/guides/defining-profiles/)
- [Coding agents & capabilities](/reference/workers/)
- [Using MCP servers, skills & extensions](/guides/mcp-skills-extensions/)
