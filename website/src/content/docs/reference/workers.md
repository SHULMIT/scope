---
title: Coding agents & capabilities
description: Capability matrix for the coding agents Scope can drive.
---

A **coding agent** is the AI-driven runtime that carries out a
task during a run. See
[Choosing a coding agent](/guides/choosing-a-coding-agent/) for the
conceptual overview.

## Capability matrix

| Capability | GitHub Copilot CLI | Claude Code CLI | VS Code Copilot |
| --- | :---: | :---: | :---: |
| Drives | GitHub Copilot via ACP | Anthropic Claude Code via ACP | Electron VS Code with driver extension |
| Models | Copilot model list | Claude Code model list | VS Code model list |
| Pin `agentVersion` | ✅ | ✅ | ✅ |
| MCP servers | ✅ | ✅ | ✅ |
| Copilot skills | ✅ | — | ✅ (when running Copilot) |
| VS Code extensions | ❌ (HTTP 400) | ❌ (HTTP 400) | ✅ |
| Startup time | Fast | Fast | Slower (boots Electron) |

For per-agent model lists, open the profile editor in the
Portal — the model dropdown reflects what the chosen coding
agent currently advertises.

## Worker IDs

Use these strings as the `workerType` field in profiles and
runs.

- `coder-acp-copilot` — GitHub Copilot CLI
- `coder-acp-claude-code` — Claude Code CLI

## See also

- [Choosing a coding agent](/guides/choosing-a-coding-agent/)
- [Defining profiles](/guides/defining-profiles/)
- [Using MCP servers, skills & extensions](/guides/mcp-skills-extensions/)
