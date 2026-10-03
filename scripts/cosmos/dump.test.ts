// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { CosmosCliError } from "./shared.js";
import { diffDumpVerification, parseArgs, parseDumpLog } from "./dump.js";

describe("dump parseArgs", () => {
  it("uses defaults", () => {
    expect(parseArgs([], {})).toMatchObject({ env: "int2", account: "db-scope-v2-int2", resourceGroup: "rg-scope-v2-int2", database: "scope-mt", kubeNamespace: "default" });
  });

  it("parses each flag", () => {
    const opts = parseArgs(["--env", "prod", "--account", "db-x", "--resource-group", "rg-x", "--database", "db", "--subscription", "sub", "--out", "out", "--docker", "--via-kubectl", "--kube-context", "ctx", "--namespace", "ns", "--"], {});
    expect(opts).toMatchObject({ env: "prod", account: "db-x", resourceGroup: "rg-x", database: "db", subscription: "sub", outDir: "out", forceDocker: true, viaKubectl: true, kubeContext: "ctx", kubeNamespace: "ns" });
  });

  it("uses SCOPE_ENV and lets flags override presets", () => {
    const opts = parseArgs(["--account", "custom"], { SCOPE_ENV: "int" });
    expect(opts.account).toBe("custom");
    expect(opts.resourceGroup).toBe("rg-scope-v2-int");
  });

  it("throws exit 2 for unknown flags", () => {
    expect(() => parseArgs(["--wat"], {})).toThrow(CosmosCliError);
    try { parseArgs(["--wat"], {}); } catch (err) { expect((err as CosmosCliError).exitCode).toBe(2); }
  });
});

describe("dump log parsing and verification", () => {
  it("parses collection counts from mongodump output", () => {
    const log = "2026 done dumping scope-mt.beta (2 documents)\n2026 done dumping scope-mt.alpha (1 document)";
    expect(parseDumpLog(log, "scope-mt")).toEqual({ alpha: 1, beta: 2 });
  });

  it("computes missing, extra, and totals", () => {
    expect(diffDumpVerification(["alpha", "beta"], { alpha: 3, gamma: 4 })).toEqual({ missing: ["beta"], extra: ["gamma"], totalDocuments: 7, collectionsDumped: 2 });
  });
});
