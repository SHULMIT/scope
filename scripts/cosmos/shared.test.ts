// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { CosmosCliError, resolvePreset, selectRunner, uriWithDb } from "./shared.js";

describe("resolvePreset", () => {
  it("resolves known environments", () => {
    expect(resolvePreset("int2")).toMatchObject({ account: "db-scope-v2-int2", resourceGroup: "rg-scope-v2-int2", database: "scope-mt" });
    expect(resolvePreset("int")).toMatchObject({ account: "db-scope-v2-int", resourceGroup: "rg-scope-v2-int", database: "scope-mt" });
    expect(resolvePreset("prod")).toMatchObject({ account: "db-scope-v2-prd", resourceGroup: "rg-scope-v2-prd", database: "scope-mt" });
  });

  it("lets flag overrides win", () => {
    expect(resolvePreset("prod", { account: "db-x", resourceGroup: "rg-x", database: "custom" })).toEqual({ env: "prod", account: "db-x", resourceGroup: "rg-x", database: "custom" });
  });

  it("throws with exit 2 for unknown env", () => {
    expect(() => resolvePreset("dev")).toThrow(CosmosCliError);
    try {
      resolvePreset("dev");
    } catch (err) {
      expect((err as CosmosCliError).exitCode).toBe(2);
    }
  });
});

describe("uriWithDb", () => {
  it("injects db before query string", () => {
    expect(uriWithDb("mongodb://host/?ssl=true", "scope-mt")).toBe("mongodb://host/scope-mt?ssl=true");
  });

  it("injects db without query string", () => {
    expect(uriWithDb("mongodb://host", "scope-mt")).toBe("mongodb://host/scope-mt");
  });

  it("handles base with trailing slash", () => {
    expect(uriWithDb("mongodb://host/", "scope-mt")).toBe("mongodb://host/scope-mt");
  });

  it("handles base without trailing slash and with query", () => {
    expect(uriWithDb("mongodb://host:10255?ssl=true", "scope-mt")).toBe("mongodb://host:10255/scope-mt?ssl=true");
  });
});

describe("selectRunner", () => {
  const base = { toolName: "mongodump" as const, hasMongoTool: false, hasDocker: false, dockerInfoOk: false, forceDocker: false, viaKubectl: false };

  it("selects kubectl when requested", () => {
    expect(selectRunner({ ...base, viaKubectl: true, hasKubectl: true, namespaceReachable: true })).toEqual({ ok: true, runner: "kubectl" });
  });

  it("selects native when available", () => {
    expect(selectRunner({ ...base, hasMongoTool: true })).toEqual({ ok: true, runner: "native" });
  });

  it("force-docker skips native", () => {
    expect(selectRunner({ ...base, forceDocker: true, hasMongoTool: true, hasDocker: true, dockerInfoOk: true })).toEqual({ ok: true, runner: "docker" });
  });

  it("falls back to docker", () => {
    expect(selectRunner({ ...base, hasDocker: true, dockerInfoOk: true })).toEqual({ ok: true, runner: "docker" });
  });

  it("returns a typed unavailability when nothing is available", () => {
    const result = selectRunner(base);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.messages[0]).toBe("no mongodump available.");
  });
});
