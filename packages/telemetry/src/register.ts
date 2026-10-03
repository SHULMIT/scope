// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Side-effect-only module that initializes OpenTelemetry when loaded via
 * `node --import telemetry/register`. This ensures auto-instrumentation hooks
 * are registered before any application modules (Express, MongoDB, etc.) are loaded.
 *
 * Usage in Dockerfiles:
 *   CMD ["node", "--import", "telemetry/register", "dist/index.js"]
 *
 * The service name is resolved from env vars in priority order:
 *   OTEL_SERVICE_NAME > WORKER_NAME > "unknown"
 *
 * Controlled by the `OTEL_ENABLED` env var (injected by the otel-collector
 * Kustomize Component). When absent or "false", telemetry is skipped entirely.
 * Same pattern as SCOPE_AUTH_ENABLED — toggle per overlay, requires rollout.
 *
 * For local development (without --import), the in-app initTelemetry("name") call
 * still works — the register module is not required, just preferred for production.
 */
import { initTelemetry } from "./telemetry-client.js";

const otelEnabled = process.env.OTEL_ENABLED?.toLowerCase() === "true";

if (otelEnabled) {
  const serviceName =
    process.env.OTEL_SERVICE_NAME ||
    process.env.WORKER_NAME ||
    "unknown";

  initTelemetry(serviceName);
} else {
  if (process.env.NODE_ENV !== "test") {
    process.stderr.write(`[telemetry] Disabled (OTEL_ENABLED=${process.env.OTEL_ENABLED ?? "unset"})\n`);
  }
}
