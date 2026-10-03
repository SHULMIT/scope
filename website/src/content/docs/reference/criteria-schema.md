---
title: Criteria schema
description: Field reference for Scope criteria.
---

Criteria are individual records that always live in a **directed
acyclic graph (DAG)**. Each criterion has a stable ID, a `prompt`
describing what to look for, and an optional `dependsOn` list. There
is no separate "flat" mode — criteria with no `dependsOn` are simply
roots of the graph. See
[Defining evaluation criteria](/guides/defining-criteria/) for the
conceptual overview.

A request references criteria by ID in `scenario.criteria` — see
[Submitting requests (REST API)](/guides/submitting-requests-api/).

## Criterion

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | Stable identifier matching `^[a-z][a-z0-9_]*$`. Used in `dependsOn` references and in run reports. |
| `prompt` | string | yes | The criterion statement / evaluation prompt. The judge uses this to decide pass/fail against the run output. |
| `dependsOn` | string[] | no | IDs of parent criteria. The criterion is only evaluated if all parents pass. Omit for a root criterion. |

`dependsOn` references **must form a DAG** — cycles are rejected.
Referenced parent IDs must exist.

## Graph view

The API also exposes a graph view (`/api/v1/criteria/graph`) returning
`nodes` (`{id, prompt, dependsOn?}`) and derived `edges`
(`{from, to}`). This is the canonical structure used by the judge
when scheduling evaluation order.

## Examples

### All roots (no edges)

```yaml
- id: has_package_json
  prompt: Has a package.json with express as a dependency
- id: has_express_server
  prompt: Has an entry file creating an Express server
- id: has_root_route
  prompt: GET / returns a hello world response
- id: configurable_port
  prompt: The server listens on a configurable port
```

Every criterion is a root, so all four are evaluated independently.

### With dependencies

```yaml
- id: has_package_json
  prompt: Has a package.json with express as a dependency
- id: has_express_server
  prompt: Has an entry file creating an Express server
  dependsOn: [has_package_json]
- id: has_root_route
  prompt: GET / returns a hello world response
  dependsOn: [has_express_server]
- id: configurable_port
  prompt: The server listens on a configurable port
  dependsOn: [has_express_server]
```

## Mutability

Criteria are mutable via `PATCH /api/v1/criteria/{id}`. Past run
reports are computed from criteria as they were at submission time,
so edits don't change historical results.

## See also

- [Defining evaluation criteria](/guides/defining-criteria/)
- [Submitting requests (REST API)](/guides/submitting-requests-api/)
