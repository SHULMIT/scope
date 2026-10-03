// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const useAzureMonitor = vi.fn();
const shutdownAzureMonitor = vi.fn().mockResolvedValue(undefined);

vi.mock("@azure/monitor-opentelemetry", () => ({
  useAzureMonitor: (options: unknown) => useAzureMonitor(options),
  shutdownAzureMonitor: () => shutdownAzureMonitor(),
}));

const getMeterMock = vi.fn((_name?: string) => ({}));
vi.mock("@opentelemetry/api", () => ({
  metrics: { getMeter: (name?: string) => getMeterMock(name) },
}));

const { sdkStartMock, sdkShutdownMock, NodeSDKMock } = vi.hoisted(() => {
  const sdkStartMock = vi.fn();
  const sdkShutdownMock = vi.fn().mockResolvedValue(undefined);
  // Use a class so it's constructable with `new`
  const NodeSDKMock = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.start = sdkStartMock;
    this.shutdown = sdkShutdownMock;
  });
  return { sdkStartMock, sdkShutdownMock, NodeSDKMock };
});

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: NodeSDKMock,
}));

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: vi.fn(),
}));

vi.mock("@opentelemetry/exporter-metrics-otlp-http", () => ({
  OTLPMetricExporter: vi.fn(),
}));

vi.mock("@opentelemetry/exporter-logs-otlp-http", () => ({
  OTLPLogExporter: vi.fn(),
}));

vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: vi.fn((attrs: unknown) => ({ attributes: attrs })),
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
}));

vi.mock("@opentelemetry/sdk-metrics", () => ({
  PeriodicExportingMetricReader: vi.fn(),
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BatchSpanProcessor: vi.fn(),
}));

vi.mock("@opentelemetry/sdk-logs", () => ({
  BatchLogRecordProcessor: vi.fn(),
}));

const getNodeAutoInstrumentationsMock = vi.fn((..._args: unknown[]) => [{ name: "mock-instrumentation" }]);
vi.mock("@opentelemetry/auto-instrumentations-node", () => ({
  getNodeAutoInstrumentations: (...args: unknown[]) => getNodeAutoInstrumentationsMock(...args),
}));

import {
  initTelemetry,
  isTelemetryEnabled,
  getExportMode,
  resetTelemetry,
  shutdownTelemetry,
} from "./telemetry-client.js";

describe("telemetry-client", () => {
  const savedConnStr = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  const savedSampling = process.env.TELEMETRY_SAMPLING_RATIO;
  const savedCollector = process.env.OTEL_COLLECTOR_ENDPOINT;

  beforeEach(() => {
    resetTelemetry();
    useAzureMonitor.mockClear();
    shutdownAzureMonitor.mockClear();
    NodeSDKMock.mockClear();
    sdkStartMock.mockClear();
    sdkShutdownMock.mockClear();
    getNodeAutoInstrumentationsMock.mockClear();
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    delete process.env.TELEMETRY_SAMPLING_RATIO;
    delete process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_COLLECTOR_ENDPOINT;
  });

  afterEach(() => {
    if (savedConnStr === undefined) delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    else process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = savedConnStr;
    if (savedSampling === undefined) delete process.env.TELEMETRY_SAMPLING_RATIO;
    else process.env.TELEMETRY_SAMPLING_RATIO = savedSampling;
    if (savedCollector === undefined) delete process.env.OTEL_COLLECTOR_ENDPOINT;
    else process.env.OTEL_COLLECTOR_ENDPOINT = savedCollector;
  });

  describe("no-op mode", () => {
    it("is a no-op when no env vars are set", () => {
      initTelemetry("svc");
      expect(useAzureMonitor).not.toHaveBeenCalled();
      expect(NodeSDKMock).not.toHaveBeenCalled();
      expect(isTelemetryEnabled()).toBe(false);
      expect(getExportMode()).toBe("none");
    });
  });

  describe("direct mode (Azure Monitor)", () => {
    it("initializes Azure Monitor when connection string is set", () => {
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = "InstrumentationKey=abc";
      initTelemetry("my-service");
      expect(useAzureMonitor).toHaveBeenCalledTimes(1);
      expect(NodeSDKMock).not.toHaveBeenCalled();
      expect(isTelemetryEnabled()).toBe(true);
      expect(getExportMode()).toBe("direct");
      expect(process.env.OTEL_SERVICE_NAME).toBe("my-service");
    });

    it("passes the sampling ratio from the environment", () => {
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = "InstrumentationKey=abc";
      process.env.TELEMETRY_SAMPLING_RATIO = "0.25";
      initTelemetry("svc");
      expect(useAzureMonitor).toHaveBeenCalledWith(
        expect.objectContaining({ samplingRatio: 0.25, enableLiveMetrics: true }),
      );
    });

    it("defaults the sampling ratio to 1.0 for invalid values", () => {
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = "InstrumentationKey=abc";
      process.env.TELEMETRY_SAMPLING_RATIO = "not-a-number";
      initTelemetry("svc");
      expect(useAzureMonitor).toHaveBeenCalledWith(
        expect.objectContaining({ samplingRatio: 1.0 }),
      );
    });

    it("shuts down Azure Monitor in direct mode", async () => {
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = "InstrumentationKey=abc";
      initTelemetry("svc");
      await shutdownTelemetry();
      expect(shutdownAzureMonitor).toHaveBeenCalledTimes(1);
      expect(sdkShutdownMock).not.toHaveBeenCalled();
    });
  });

  describe("collector mode (OTLP)", () => {
    it("initializes NodeSDK with OTLP exporters when collector endpoint is set", () => {
      process.env.OTEL_COLLECTOR_ENDPOINT = "http://otel-collector:4318";
      initTelemetry("my-service");
      expect(NodeSDKMock).toHaveBeenCalledTimes(1);
      expect(sdkStartMock).toHaveBeenCalledTimes(1);
      expect(useAzureMonitor).not.toHaveBeenCalled();
      expect(isTelemetryEnabled()).toBe(true);
      expect(getExportMode()).toBe("collector");
    });

    it("collector mode takes priority over direct mode", () => {
      process.env.OTEL_COLLECTOR_ENDPOINT = "http://otel-collector:4318";
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = "InstrumentationKey=abc";
      initTelemetry("svc");
      expect(NodeSDKMock).toHaveBeenCalledTimes(1);
      expect(useAzureMonitor).not.toHaveBeenCalled();
      expect(getExportMode()).toBe("collector");
    });

    it("shuts down NodeSDK in collector mode", async () => {
      process.env.OTEL_COLLECTOR_ENDPOINT = "http://otel-collector:4318";
      initTelemetry("svc");
      await shutdownTelemetry();
      expect(sdkShutdownMock).toHaveBeenCalledTimes(1);
      expect(shutdownAzureMonitor).not.toHaveBeenCalled();
    });

    it("configures auto-instrumentations with noisy modules disabled", () => {
      process.env.OTEL_COLLECTOR_ENDPOINT = "http://otel-collector:4318";
      initTelemetry("svc");
      expect(getNodeAutoInstrumentationsMock).toHaveBeenCalledTimes(1);
      const config = getNodeAutoInstrumentationsMock.mock.calls[0][0] as Record<string, unknown>;
      expect(config["@opentelemetry/instrumentation-fs"]).toEqual({ enabled: false });
      expect(config["@opentelemetry/instrumentation-dns"]).toEqual({ enabled: false });
      expect(config["@opentelemetry/instrumentation-net"]).toEqual({ enabled: false });
      // Verify instrumentations array was passed to NodeSDK
      expect(NodeSDKMock).toHaveBeenCalledWith(
        expect.objectContaining({
          instrumentations: [[{ name: "mock-instrumentation" }]],
        }),
      );
    });
  });

  describe("shared behavior", () => {
    it("does not re-initialize when called multiple times", () => {
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = "InstrumentationKey=abc";
      initTelemetry("svc");
      initTelemetry("svc");
      initTelemetry("svc");
      expect(useAzureMonitor).toHaveBeenCalledTimes(1);
    });

    it("allows re-initialization after resetTelemetry()", () => {
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = "InstrumentationKey=abc";
      initTelemetry("svc");
      expect(useAzureMonitor).toHaveBeenCalledTimes(1);

      resetTelemetry();
      expect(isTelemetryEnabled()).toBe(false);
      expect(getExportMode()).toBe("none");

      initTelemetry("svc");
      expect(useAzureMonitor).toHaveBeenCalledTimes(2);
    });

    it("shutdown is a no-op when telemetry is not enabled", async () => {
      await shutdownTelemetry();
      expect(shutdownAzureMonitor).not.toHaveBeenCalled();
      expect(sdkShutdownMock).not.toHaveBeenCalled();
    });
  });
});
