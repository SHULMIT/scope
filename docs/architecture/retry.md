# Retry Utilities

The shared package (`packages/shared/src/utils/retry.ts`) provides retry primitives for handling transient failures across the platform. Both a functional API and a method decorator are available.

## Dependencies

Built on [cockatiel](https://www.npmjs.com/package/cockatiel) which provides exponential backoff with jitter out of the box.

## API

### `withRetry<T>(fn, options?): Promise<T>`

Wraps an async function with retry logic. If `fn` throws a retryable error, it is retried with exponential backoff.

```typescript
import { withRetry } from "shared";

const data = await withRetry(
  () => fetchFromApi("/resource"),
  {
    maxRetries: 3,
    baseDelayMs: 500,
    maxDelayMs: 5000,
    isRetryable: (err) => isTransient(err),
    onRetry: (err, attempt) => console.warn(`Attempt ${attempt} failed`),
  },
);
```

### `@Retry(options?)` decorator

TC39 method decorator (no `experimentalDecorators` needed) that wraps an async method with retry logic. Preserves `this` context.

```typescript
import { Retry } from "shared";

class MyService {
  @Retry({ maxRetries: 3, baseDelayMs: 1000, isRetryable: () => true })
  async callExternalApi(): Promise<Response> {
    const res = await fetch("https://api.example.com/data");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }
}
```

The decorator is equivalent to wrapping the method body with `withRetry` but keeps the retry concern declarative and separate from business logic.

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxRetries` | `number` | `5` | Maximum retry attempts (not counting the initial call) |
| `baseDelayMs` | `number` | `100` | Initial delay before the first retry |
| `maxDelayMs` | `number` | `5000` | Maximum delay cap between retries |
| `isRetryable` | `(error: unknown) => boolean` | `isCosmosDb429` | Predicate deciding if an error should be retried |
| `onRetry` | `(error: unknown, attempt: number) => void` | console.warn | Called before each retry attempt |

## Built-in predicates

### `isCosmosDb429(error): boolean`

Returns `true` if the error message contains `"TooManyRequests"` or `"Request rate is large"` -- the standard CosmosDB 429 throttling patterns.

### `isRetryableJudgeError(error): boolean`

Lives in `packages/shared/src/judge/judge-client.ts` and gates retries of the worker→judge `evaluate()` call. It retries transient judge-side `5xx` `JudgeInfrastructureError`s (but never a version mismatch) and transport-level network failures.

> **Undici gotcha:** when `fetch()` fails at the transport layer, undici throws `TypeError: fetch failed` where `error.message` is literally just `"fetch failed"` and the real reason (`ECONNRESET`, `socket hang up`, etc.) lives in **`error.cause`** (its `.message` and/or `.code`). Predicates that only inspect `error.message` will never see these and won't retry. `isRetryableJudgeError` therefore matches `"fetch failed"` explicitly and folds `error.cause`'s message and code into the searched string. Apply the same pattern to any predicate that classifies `fetch` errors. See scope #1317.

## Design guidelines

- **Use the decorator** when retry is a cross-cutting concern on a method and the default `isRetryable` logic applies uniformly to all errors the method might throw.
- **Use `withRetry`** when you need conditional logic inside the retry loop (e.g., distinguishing 4xx from 5xx before deciding to retry).
- **Always set `isRetryable`** explicitly for non-database calls. The default predicate only matches CosmosDB 429 errors.
- **Wrap best-effort calls in try/catch** at the call site if the operation should not fail the parent workflow (e.g., report triggering should not fail post-processing).
- **Never stack retry layers.** Retry belongs to exactly one layer per call. Do not combine an HTTP client's built-in retry with `withRetry`/`@Retry` around the same call — attempts compound to `maxRetries × client.limit`.

## Layering with HTTP clients (`ky`)

The `ky` clients used by the CLI (`apps/cli/src/utils/api-client.ts`) and Portal
(`apps/portal/src/lib/api-client.ts`) deliberately set `retry: 0`, so today there is no
overlap with the server-side cockatiel retry. If the CLI or Portal ever needs to retry
transient `429`/`503`s, pick **one** layer:

- enable `ky`'s `retry` (with its own backoff), **or**
- wrap the call in `withRetry` / `@Retry`.

Do not enable both, or attempts multiply to `maxRetries × ky.limit`.

## Usage in the codebase

| Component | Usage | Pattern |
|-----------|-------|---------|
| Post-processor worker | Report trigger after enrichment | `@Retry` decorator |
| Blob storage | Upload/download retries | `withRetry` function |
| Queue scheduler | CosmosDB operations | `withRetry` with default `isCosmosDb429` |
| Judge client | Worker→judge `evaluate()` transport + `5xx` failures | `withRetry` with `isRetryableJudgeError` |
