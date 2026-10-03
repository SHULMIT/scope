// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const record = vi.fn();
const add = vi.fn();
const createHistogram = vi.fn(() => ({ record }));
const createCounter = vi.fn(() => ({ add }));
const meter = { createHistogram, createCounter };

let telemetryEnabled = true;

vi.mock("./telemetry-client.js", () => ({
  isTelemetryEnabled: () => telemetryEnabled,
  getMeter: () => meter,
}));

import { trackMetric, trackTrace, trackEvent } from "./helpers.js";

describe("telemetry helpers", () => {
  const savedLogLevel = process.env.TELEMETRY_LOG_LEVEL;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleWarn: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    telemetryEnabled = true;
    record.mockClear();
    add.mockClear();
    createHistogram.mockClear();
    createCounter.mockClear();
    delete process.env.TELEMETRY_LOG_LEVEL;
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLog.mockRestore();
    consoleWarn.mockRestore();
    consoleError.mockRestore();
    if (savedLogLevel === undefined) delete process.env.TELEMETRY_LOG_LEVEL;
    else process.env.TELEMETRY_LOG_LEVEL = savedLogLevel;
  });

  describe("trackMetric", () => {
    it("records a histogram when telemetry is enabled", () => {
      trackMetric({ name: "worker.run_duration_ms", value: 42, properties: { runId: "r1" } });
      expect(createHistogram).toHaveBeenCalledWith("worker.run_duration_ms");
      expect(record).toHaveBeenCalledWith(42, { runId: "r1" });
    });

    it("is a no-op when telemetry is disabled", () => {
      telemetryEnabled = false;
      trackMetric({ name: "worker.run_duration_ms", value: 42 });
      expect(createHistogram).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });
  });

  describe("trackEvent", () => {
    it("increments a counter when telemetry is enabled", () => {
      trackEvent({ name: "worker.run_started", properties: { runId: "r1" } });
      expect(createCounter).toHaveBeenCalledWith("worker.run_started");
      expect(add).toHaveBeenCalledWith(1, { runId: "r1" });
    });

    it("is a no-op when telemetry is disabled", () => {
      telemetryEnabled = false;
      trackEvent({ name: "worker.run_started" });
      expect(createCounter).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
    });
  });

  describe("trackTrace", () => {
    it("is a no-op when telemetry is disabled", () => {
      telemetryEnabled = false;
      trackTrace({ message: "boom", severityLevel: "Error" });
      expect(consoleError).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();
      expect(consoleLog).not.toHaveBeenCalled();
    });

    it("drops traces below the default (Warning) threshold", () => {
      trackTrace({ message: "chatty", severityLevel: "Verbose" });
      trackTrace({ message: "info", severityLevel: "Information" });
      expect(consoleLog).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    });

    it("forwards traces at or above the default threshold", () => {
      trackTrace({ message: "careful", severityLevel: "Warning" });
      expect(consoleWarn).toHaveBeenCalledTimes(1);

      trackTrace({ message: "broke", severityLevel: "Error" });
      expect(consoleError).toHaveBeenCalledTimes(1);
    });

    it("respects a custom TELEMETRY_LOG_LEVEL threshold", () => {
      process.env.TELEMETRY_LOG_LEVEL = "Verbose";
      trackTrace({ message: "chatty", severityLevel: "Verbose" });
      expect(consoleLog).toHaveBeenCalledTimes(1);
    });

    it("suppresses lower levels when threshold is raised", () => {
      process.env.TELEMETRY_LOG_LEVEL = "Error";
      trackTrace({ message: "careful", severityLevel: "Warning" });
      expect(consoleWarn).not.toHaveBeenCalled();

      trackTrace({ message: "broke", severityLevel: "Error" });
      expect(consoleError).toHaveBeenCalledTimes(1);
    });
  });
});
