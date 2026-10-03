// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { CosmosCliError } from "./shared.js";
import { buildRestoreArgs, checkForceDropGuardrail, parseArgs, pickNewestArchive } from "./restore.js";

describe("restore parseArgs", () => {
  it("uses defaults", () => {
    expect(parseArgs([], {})).toMatchObject({ env: "int2", account: "db-scope-v2-int2", resourceGroup: "rg-scope-v2-int2", database: "scope-mt", execute: false, inPlace: false, kubeNamespace: "default" });
  });

  it("parses each flag", () => {
    const opts = parseArgs(["--env", "prod", "--account", "db-x", "--resource-group", "rg-x", "--database", "db", "--to-database", "target", "--archive", "a.gz", "--subscription", "sub", "--out", "out", "--batch-size", "1", "--docker", "--via-kubectl", "--kube-context", "ctx", "--namespace", "ns", "--execute", "--in-place", "--force-drop", "--yes", "--"], {});
    expect(opts).toMatchObject({ env: "prod", account: "db-x", resourceGroup: "rg-x", database: "db", toDatabase: "target", archive: "a.gz", subscription: "sub", outDir: "out", batchSize: "1", forceDocker: true, viaKubectl: true, kubeContext: "ctx", kubeNamespace: "ns", execute: true, inPlace: true, forceDrop: true, assumeYes: true });
  });

  it("uses SCOPE_ENV and lets flags override presets", () => {
    const opts = parseArgs(["--resource-group", "custom-rg"], { SCOPE_ENV: "prod" });
    expect(opts.account).toBe("db-scope-v2-prd");
    expect(opts.resourceGroup).toBe("custom-rg");
  });

  it("throws exit 2 for unknown flags", () => {
    expect(() => parseArgs(["--bad"], {})).toThrow(CosmosCliError);
    try { parseArgs(["--bad"], {}); } catch (err) { expect((err as CosmosCliError).exitCode).toBe(2); }
  });
});

describe("buildRestoreArgs", () => {
  it("builds dry-run args by default", () => {
    expect(buildRestoreArgs({ database: "scope-mt", targetDatabase: "scope-mt-restore", execute: false, forceDrop: false, batchSize: "" })).toEqual([
      "--gzip",
      "--numParallelCollections=1",
      "--numInsertionWorkersPerCollection=1",
      "--nsInclude=scope-mt.*",
      "--nsFrom=scope-mt.*",
      "--nsTo=scope-mt-restore.*",
      "--dryRun",
    ]);
  });

  it("omits dryRun when execute is true", () => {
    expect(buildRestoreArgs({ database: "db", targetDatabase: "target", execute: true, forceDrop: false, batchSize: "" })).not.toContain("--dryRun");
  });

  it("adds force-drop and batch size", () => {
    expect(buildRestoreArgs({ database: "db", targetDatabase: "db", execute: true, forceDrop: true, batchSize: "1" })).toContain("--drop");
    expect(buildRestoreArgs({ database: "db", targetDatabase: "db", execute: true, forceDrop: true, batchSize: "1" })).toContain("--batchSize=1");
  });
});

describe("force-drop guardrail", () => {
  it("allows force drop in-place", () => {
    expect(() => checkForceDropGuardrail(true, true)).not.toThrow();
  });

  it("rejects force drop outside in-place", () => {
    expect(() => checkForceDropGuardrail(true, false)).toThrow(CosmosCliError);
  });
});

describe("pickNewestArchive", () => {
  it("selects newest by mtime", () => {
    expect(pickNewestArchive([{ path: "old", mtimeMs: 1 }, { path: "new", mtimeMs: 2 }])).toBe("new");
  });

  it("returns undefined for empty candidates", () => {
    expect(pickNewestArchive([])).toBeUndefined();
  });
});
