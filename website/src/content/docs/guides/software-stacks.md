---
title: Choosing software stacks
description: Which languages, runtimes, and build tools are pre-installed in each Scope worker.
---

Every worker container ships with a set of pre-installed
runtimes and build tools. These determine which languages
the agent can use out of the box — if a runtime isn't in
the container, the agent can't compile or run code in that
language.

## Support matrix

| Tool | Purpose | GitHub Copilot CLI | Claude Code CLI | VS Code Copilot |
| --- | --- | :---: | :---: | :---: |
| `python3` | Python runtime | ✅ | ✅ | ✅ |
| `uv` | Python package manager | ✅ | ✅ | ✅ |
| `node` | Node.js / JavaScript / TypeScript | ✅ | ✅ | ✅ |
| `go` | Go compiler | ✅ | ✅ | ✅ |
| `dotnet` | C# / .NET SDK | ✅ | ✅ | ✅ |
| `rustc` | Rust compiler | ✅ | ✅ | ✅ |
| `cargo` | Rust package manager | ✅ | ✅ | ✅ |
| `java` | Java runtime | ✅ | ✅ | ✅ |
| `mvn` | Maven build tool | ✅ | ✅ | ✅ |
| `gradle` | Gradle build tool | ✅ | ✅ | ✅ |
| `pwsh` | PowerShell | ✅ | ✅ | ✅ |
| `git` | Version control | ✅ | ✅ | ✅ |

## What this means for your benchmarks

- **Every runtime is available on every worker.** Python,
  Node.js, Go, .NET, Rust, and Java are all pre-installed
  across all three workers, so language choice doesn't
  constrain your worker selection.
- **All workers share the same Java toolchain.** Maven
  *and* Gradle are both available, so tasks can use
  either build system.
- **Rust has full support everywhere.** Both `rustc` and
  `cargo` are installed on every worker.
- **`uv` is the Python package manager.** Workers use
  [uv](https://docs.astral.sh/uv/) instead of `pip`
  for fast, reproducible Python dependency installs.

## See also

- [Choosing a coding agent](/guides/choosing-a-coding-agent/)
- [Coding agents & capabilities](/reference/workers/)
- [Defining profiles](/guides/defining-profiles/)
