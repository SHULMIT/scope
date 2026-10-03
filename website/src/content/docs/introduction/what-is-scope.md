---
title: What is Scope?
description: An overview of Scope — the platform for measuring the agentic coding experience across agents, at scale.
---

**Scope** is a self-service platform for **measuring the agentic
coding experience of your product surfaces, skills, MCP servers,
and extensions** — across agents, at scale. It runs the same coding
task across different agents, tools, and models, evaluates the
outcomes against criteria you define, and lets you compare results
side by side.

The goal isn't just "did the code work?" — it's understanding how
the agent *behaved* on the way there: what it asked for, what tools
it reached for, where it got stuck, and how that changes when you
swap the agent, the model, or the surrounding tools.

## What you can do with Scope

- **Submit a coding task** and have it executed by your choice of agent —
  GitHub Copilot, Claude Code, or VS Code with the Copilot driver
  extension.
- **Save reusable agent setups as profiles** — a profile bundles the
  worker, model, agent version, MCP servers, skills, and extensions so
  you can re-run the same configuration consistently.
- **Define what "good" looks like** with evaluation criteria. Criteria
  live in a directed acyclic graph (DAG) so children can be gated on
  their parents passing — use it for multi-step evaluation, or just
  leave dependencies off and every criterion becomes a root.
- **Watch runs in real time** as logs stream from the worker.
- **Compare across heterogeneous tasks** using prompt features —
  characteristics Scope detects on your task prompt (e.g. "asks for
  an API", "asks for TypeScript") so you can ask questions like *"how
  does Claude Code do on database tasks vs. Copilot?"* without manually
  tagging every run.
- **Automate everything** through the REST API or the `scope` CLI —
  submit runs, manage profiles and criteria, fetch results.

## When Scope is the right tool

Use Scope when you want to:

- Compare the agentic behavior of two or more coding agents on the
  same task.
- Track how a single agent's behavior changes across versions or model
  swaps.
- Evaluate the impact of MCP servers, skills, or extensions on coding
  outcomes.
- Build a shared, reproducible measurement suite that your team can
  extend over time.

It is **not** a hosted IDE or an agent runtime you embed in your own
products — it's a measurement platform that drives existing agents
against tasks you control.

## Who it's for

Scope is for teams that need to measure and compare AI coding
agents:

- **Engineers** designing task prompts and criteria to characterize the
  agentic experience.
- **Researchers** comparing agent trajectories across diverse tasks.
- **Pipelines and tooling** that submit runs programmatically via the
  REST API.

## Where to next

- New here? Read [Concepts](/introduction/concepts/) to get familiar with
  the vocabulary.
- Ready to submit your first run? Jump to
  [Access](/getting-started/access/).
