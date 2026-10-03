---
title: Prompt feature schema
description: Field reference for Scope prompt features and detection results.
---

A **prompt feature** is a boolean characteristic detected on a task
prompt. See [Working with prompt features](/guides/prompt-features/)
for the conceptual overview.

## Feature (catalog entry)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | Stable `snake_case` identifier (e.g. `asks_for_api`). |
| `description` | string | no | Short human-readable description. |
| `prompt` | string | yes | The detection prompt sent to the LLM, asking whether the feature applies to a given task prompt. |
| `dependsOn` | string[] | no | IDs of parent features. A feature is only evaluated if all parents are detected as true. |
| `createdAt` | string (ISO-8601) | auto | Creation timestamp. |

## Detection result (per task prompt)

When you extract features on a task prompt, the API returns:

| Field | Type | Description |
| --- | --- | --- |
| `taskPromptId` | string | The task prompt that was analyzed. |
| `features` | DetectedFeature[] | One entry per catalog feature evaluated. |
| `suggestedFeatures` | SuggestedFeature[] | New feature suggestions the LLM identified from this prompt. |
| `extractedAt` | string (ISO-8601) | When extraction last ran. |

### `DetectedFeature`

| Field | Type | Description |
| --- | --- | --- |
| `featureId` | string | Catalog feature ID. |
| `detected` | boolean | Whether the feature applies to this prompt. |
| `manuallyEvaluated` | boolean | True if a user has overridden the LLM's verdict. |

### `SuggestedFeature`

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Suggested `snake_case` ID. |
| `description` | string | What the suggested feature would detect. |
| `prompt` | string | Suggested detection prompt. |

## Example

```json
{
  "id": "asks_for_api",
  "description": "The task asks the agent to build an HTTP API.",
  "prompt": "Does the task explicitly ask for a REST, gRPC, or other HTTP API to be created?"
}
```

## See also

- [Working with prompt features](/guides/prompt-features/)
- [REST API reference](/reference/rest-api/#prompt-features)
