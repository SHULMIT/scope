// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useAzureMonitor, shutdownAzureMonitor } from "@azure/monitor-opentelemetry";
import { metrics, type Meter } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

let initialized = false;
let enabled = false;
let exportMode: "collector" | "direct" | "none" = "none";
let nodeSDK: NodeSDK | null = null;

/**
 * Initialize OpenTelemetry telemetry.
 *
 * Supports two export modes:
 * 1. **Collector mode** — when `OTEL_COLLECTOR_ENDPOINT` is set, sends OTLP HTTP
 *    to an in-cluster OTel Collector which forwards to App Insights.
 * 2. **Direct mode** — when only `APPLICATIONINSIGHTS_CONNECTION_STRING` is set,
 *    uses `useAzureMonitor()` to export directly to App Insights (Breeze endpoint).
 *
 * Collector mode takes priority when both env vars are set.
 * If neither is set, telemetry is disabled and all helper functions become no-ops.
 *
 * Must be called before any other imports that make HTTP calls (Express, MongoDB, etc.)
 * so that OpenTelemetry auto-instrumentation is applied.
 *
 * Additional configuration:
 * - `TELEMETRY_SAMPLING_RATIO` — fraction of telemetry to sample (0.0–1.0, default 1.0)
 *
 * @param serviceName - Logical name for this service (e.g., "coder-acp-copilot", "api").
 */
export function initTelemetry(serviceName?: string): void {
  if (initialized) return;
  initialized = true;

  const collectorEndpoint = process.env.OTEL_COLLECTOR_ENDPOINT;
  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

  if (collectorEndpoint) {
    initWithCollector(serviceName, collectorEndpoint);
  } else if (connectionString) {
    initWithAzureMonitor(serviceName, connectionString);
  }
  // else: no-op — telemetry disabled
}

function initWithCollector(serviceName: string | undefined, endpoint: string): void {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName ?? "unknown",
  });

  const traceExporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });
  const metricExporter = new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` });
  const logExporter = new OTLPLogExporter({ url: `${endpoint}/v1/logs` });

  nodeSDK = new NodeSDK({
    resource,
    spanProcessors: [new BatchSpanProcessor(traceExporter)],
    metricReader: new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 15_000,
    }),
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: logExporter })],
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable noisy/low-value instrumentations to keep span volume sane
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
        "@opentelemetry/instrumentation-net": { enabled: false },
      }),
    ],
  });
  nodeSDK.start();

  exportMode = "collector";
  enabled = true;
}

function initWithAzureMonitor(serviceName: string | undefined, connectionString: string): void {
  if (serviceName) {
    process.env.OTEL_SERVICE_NAME = serviceName;
  }

  const samplingRatio = parseSamplingRatio(process.env.TELEMETRY_SAMPLING_RATIO);

  useAzureMonitor({
    azureMonitorExporterOptions: { connectionString },
    samplingRatio,
    enableLiveMetrics: true,
  });

  exportMode = "direct";
  enabled = true;
}

function parseSamplingRatio(raw: string | undefined): number {
  if (!raw) return 1.0;
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
    return 1.0;
  }
  return parsed;
}

/**
 * Get an OpenTelemetry Meter for recording custom metrics.
 * Returns a valid (possibly no-op) Meter even when telemetry is disabled.
 */
export function getMeter(name?: string): Meter {
  return metrics.getMeter(name || "scope");
}

/**
 * Check if telemetry is actively sending data.
 */
export function isTelemetryEnabled(): boolean {
  return enabled;
}

/**
 * Get the current export mode for diagnostics.
 */
export function getExportMode(): "collector" | "direct" | "none" {
  return exportMode;
}

/**
 * Reset the initialized/enabled flags. Intended for test isolation only.
 */
export function resetTelemetry(): void {
  initialized = false;
  enabled = false;
  exportMode = "none";
  nodeSDK = null;
}

/**
 * Flush pending telemetry and shut down. Call during graceful shutdown.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!enabled) return;

  if (exportMode === "collector" && nodeSDK) {
    await nodeSDK.shutdown();
  } else if (exportMode === "direct") {
    await shutdownAzureMonitor();
  }
}
