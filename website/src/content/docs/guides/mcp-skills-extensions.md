---
title: Using MCP servers, skills & extensions
description: Extend what an agent can do during an Scope run with MCP servers, Copilot skills, and VS Code extensions.
---

Three optional capabilities extend what an agent can do during a run:

- **MCP servers** — Model Context Protocol servers that expose tools
  the agent can call.
- **Skills** — packaged Copilot agent skills, pinned to specific
  commits.
- **Extensions** — VS Code extensions installed for the duration of a
  run. **VS Code Copilot only.**

All three are configured on a [profile](/guides/defining-profiles/),
not per-run.

## When to use what

- **MCP servers** when you want the agent to access an external system
  during the run — a knowledge base, a custom tool, a service.
- **Skills** when you want to give a Copilot-driven agent specific
  expertise (e.g. an "Azure" skill for Azure-related tasks).
- **Extensions** when you want to measure how a VS Code extension
  affects coding outcomes (e.g. linters, language servers, AI
  helpers). Requires the VS Code Copilot coding agent.

## MCP servers

MCP servers are referenced by **slug**. The slug is the name Scope
uses to identify a registered MCP server.

Add MCP servers to a profile:

```json
{
  "mcpServers": ["filesystem", "github"]
}
```

The agent gains access to whatever tools that MCP server exposes. The
behavior of those tools is part of what you're benchmarking — the
same MCP server may be used effectively by one agent and ignored by
another.

To discover the slugs registered in your Scope deployment, see the
**MCP servers** page in the Portal.

## Skills

Skills are Copilot agent skills, identified by a path inside a Git
repository:

```
github/<owner>/<repo>/<skill-path>
```

When you save a profile with a skill referenced by path, Scope
**resolves it to a commit hash** and stores the pinned form in the
profile version:

```
github/vercel-labs/agent-skills/azure@deadbeef
```

If you provide a pre-pinned reference, it passes through unchanged.

This pinning is the reason profile versions are immutable: the same
profile version run a year from now will use the *exact same* skill
code.

```json
{
  "skillRevisions": [
    "github/vercel-labs/agent-skills/azure",
    "github/vercel-labs/agent-skills/database@abc1234"
  ]
}
```

Skills only apply to Copilot-based agents.

## VS Code extensions

Extensions are identified by their VS Code Marketplace ID, optionally
pinned to a version:

```
ms-python.python
ms-python.python@2024.8.1
```

Unpinned IDs are resolved to the latest stable version at profile
version-creation time and stored as `<id>@<version>`.

```json
{
  "extensions": [
    "ms-python.python",
    "esbenp.prettier-vscode@10.4.0"
  ]
}
```

Extensions only apply to the **VS Code Copilot** coding agent. The
GitHub Copilot CLI and Claude Code CLI agents reject extensions with
HTTP 400 — see
[Defining profiles → worker-specific constraints](/guides/defining-profiles/#worker-specific-constraints).

## Combining them

A single profile can use any mix of MCP servers, skills, and (where
supported) extensions:

```json
{
  "name": "VS Code + Python + Azure",
  "model": "gpt-4o",
  "mcpServers": ["filesystem", "github"],
  "skillRevisions": ["github/vercel-labs/agent-skills/azure"],
  "extensions": ["ms-python.python"]
}
```

## Tips

- **Vary one thing at a time.** When measuring the impact of a skill
  or extension, keep everything else identical between profiles.
  Otherwise you can't attribute differences cleanly.
- **Pin everything for benchmarks you'll re-run.** Skill paths without
  commits and extension IDs without versions resolve to "latest" —
  fine for exploration, dangerous for long-lived comparisons.
- **Don't over-stack tools.** Adding three MCP servers and five skills
  to chase a higher pass rate makes the resulting profile harder to
  reason about. Smaller profiles compare better.

## See also

- [Defining profiles](/guides/defining-profiles/)
- [Choosing a coding agent](/guides/choosing-a-coding-agent/)
- [Coding agents & capabilities reference](/reference/workers/)
