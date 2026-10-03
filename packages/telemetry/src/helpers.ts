// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { getMeter, isTelemetryEnabled } from "./telemetry-client.js";
import type { TelemetryMetric, TelemetryTrace, TelemetryEvent, TelemetryDependency } from "./types.js";

type LogLevel = "Verbose" | "Information" | "Warning" | "Error" | "Critical";

const LEVEL_ORDER: Record<LogLevel, number> = {
  Verbose: 0,
  Information: 1,
  Warning: 2,
  Error: 3,
  Critical: 4,
};

const DEFAULT_LOG_LEVEL: LogLevel = "Warning";

/**
 * Resolve the minimum log level for trace forwarding from `TELEMETRY_LOG_LEVEL`.
 * Defaults to "Warning". Invalid values fall back to the default.
 */
function getConfiguredLogLevel(): LogLevel {
  const raw = process.env.TELEMETRY_LOG_LEVEL;
  if (raw && raw in LEVEL_ORDER) {
    return raw as LogLevel;
  }
  return DEFAULT_LOG_LEVEL;
}

/**
 * Record a custom metric (e.g., worker.run_duration_ms) as an OpenTelemetry histogram.
 * No-op if telemetry is not initialized.
 */
export function trackMetric(metric: TelemetryMetric): void {
  if (!isTelemetryEnabled()) return;

  const histogram = getMeter().createHistogram(metric.name);
  histogram.record(metric.value, metric.properties);
}

/**
 * Forward a trace message. Structured JSON is written to the console so that
 * Azure Monitor's console auto-collection picks it up as a log record.
 *
 * Traces are gated by `TELEMETRY_LOG_LEVEL` (default "Warning") — only traces at
 * or above the configured level are forwarded.
 * No-op if telemetry is not initialized.
 */
export function trackTrace(trace: TelemetryTrace): void {
  if (!isTelemetryEnabled()) return;

  const level = (trace.severityLevel ?? "Information") as LogLevel;
  if (LEVEL_ORDER[level] < LEVEL_ORDER[getConfiguredLogLevel()]) {
    return;
  }

  const payload = JSON.stringify({
    message: trace.message,
    severityLevel: level,
    ...trace.properties,
  });

  if (LEVEL_ORDER[level] >= LEVEL_ORDER.Error) {
    console.error(payload);
  } else if (level === "Warning") {
    console.warn(payload);
  } else {
    console.log(payload);
  }
}

/**
 * Record a custom event (e.g., worker.run_started) as an OpenTelemetry counter.
 * No-op if telemetry is not initialized.
 */
export function trackEvent(event: TelemetryEvent): void {
  if (!isTelemetryEnabled()) return;

  const counter = getMeter().createCounter(event.name);
  counter.add(1, event.properties);
}

/**
 * Record a dependency call as an OpenTelemetry histogram of its duration.
 * Success is captured as a property. No-op if telemetry is not initialized.
 */
export function trackDependency(dep: TelemetryDependency): void {
  if (!isTelemetryEnabled()) return;

  const histogram = getMeter().createHistogram(`dependency.${dep.dependencyTypeName}.duration_ms`);
  histogram.record(dep.duration, {
    name: dep.name,
    success: String(dep.success),
    ...dep.properties,
  });
}
