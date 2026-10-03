#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// cosmos-dump.ts - Snapshot a Cosmos DB for MongoDB database to a local archive
// =============================================================================
// Produces a portable, gzip-compressed mongodump archive plus a JSON manifest
// (per-collection counts, sha256, git SHA) and verifies the archive is readable.
// Intended as a rollback snapshot before a risky deploy / migration.
//
// Usage:
//   pnpm db:dump                       # default env: int2
//   pnpm db:dump -- --env int          # first int cluster
//   pnpm db:dump -- --env prod         # production
//   pnpm db:dump -- --account db-x --resource-group rg-x --database scope-mt
//   pnpm db:dump -- --out ~/cosmos-backups   # custom output dir
//   pnpm db:dump -- --docker           # force the Docker mongo:4.2 runner
//   pnpm db:dump -- --env int --via-kubectl  # run inside the cluster VNet
//                                            # (required: Cosmos is private-only)
//   pnpm db:dump -- --env int --via-kubectl --namespace scoped \
//                  --kube-context aks-scope-v2-int
//
// Prerequisites:
//   - Azure CLI logged in (az login) with access to the target account
//   - To reach the DB, one of:
//       * --via-kubectl: kubectl context whose cluster VNet has the private
//         endpoint for the target account (Scope Cosmos is publicNetworkAccess
//         Disabled, so a laptop mongodump cannot connect directly), OR
//       * a network already allowed to reach the account, plus 'mongodump' on
//         PATH (brew install mongodb-database-tools) or Docker running (the
//         script falls back to the mongo:4.2 image)
//
// Output (never committed - see .gitignore):
//   <out>/<account>/<database>-<UTC>.archive.gz         the dump
//   <out>/<account>/<database>-<UTC>.archive.gz.manifest.json
//   <out>/<account>/<database>-<UTC>.archive.gz.log      dump log
// =============================================================================

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  archiveBase,
  assertNonEmptyFile,
  azPreflight,
  CosmosCliError,
  DOCKER_IMAGE,
  gitSha,
  gzipIntegrityOk,
  kubeContextArgs,
  kubePodDelete,
  kubePodUp,
  listCosmosCollections,
  mongoToolVersion,
  parseStringFlag,
  readCosmosConnectionString,
  repoRoot,
  resolvePreset,
  resolveRunnerOrThrow,
  runBinaryToFiles,
  runStreamingCommand,
  sha256File,
  timestampUtc,
  uriWithDb,
  type ResolvedPreset,
  type Runner,
} from "./shared.js";

const MAX_RETRIES = 3;

export interface DumpOptions extends ResolvedPreset {
  subscription: string;
  forceDocker: boolean;
  viaKubectl: boolean;
  kubeContext: string;
  kubeNamespace: string;
  outDir?: string;
  help: boolean;
}

export function usage(): string {
  return `=============================================================================
cosmos-dump.ts - Snapshot a Cosmos DB for MongoDB database to a local archive
=============================================================================
Produces a portable, gzip-compressed mongodump archive plus a JSON manifest
(per-collection counts, sha256, git SHA) and verifies the archive is readable.
Intended as a rollback snapshot before a risky deploy / migration.

Usage:
  pnpm db:dump                       # default env: int2
  pnpm db:dump -- --env int          # first int cluster
  pnpm db:dump -- --env prod         # production
  pnpm db:dump -- --account db-x --resource-group rg-x --database scope-mt
  pnpm db:dump -- --out ~/cosmos-backups   # custom output dir
  pnpm db:dump -- --docker           # force the Docker mongo:4.2 runner
  pnpm db:dump -- --env int --via-kubectl  # run inside the cluster VNet
                                           # (required: Cosmos is private-only)
  pnpm db:dump -- --env int --via-kubectl --namespace scoped \\
                 --kube-context aks-scope-v2-int

Prerequisites:
  - Azure CLI logged in (az login) with access to the target account
  - To reach the DB, one of:
      * --via-kubectl: kubectl context whose cluster VNet has the private
        endpoint for the target account (Scope Cosmos is publicNetworkAccess
        Disabled, so a laptop mongodump cannot connect directly), OR
      * a network already allowed to reach the account, plus 'mongodump' on
        PATH (brew install mongodb-database-tools) or Docker running (the
        script falls back to the mongo:4.2 image)

Output (never committed - see .gitignore):
  <out>/<account>/<database>-<UTC>.archive.gz         the dump
  <out>/<account>/<database>-<UTC>.archive.gz.manifest.json
  <out>/<account>/<database>-<UTC>.archive.gz.log      dump log
=============================================================================`;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): DumpOptions {
  let envName = env.SCOPE_ENV || "int2";
  let account = "";
  let resourceGroup = "";
  let database = "";
  let subscription = "";
  let forceDocker = false;
  let viaKubectl = false;
  let kubeContext = "";
  let kubeNamespace = "default";
  let outDir = env.BACKUP_DIR || "";
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--env": envName = parseStringFlag(argv, i, arg); i++; break;
      case "--account": account = parseStringFlag(argv, i, arg); i++; break;
      case "--resource-group": resourceGroup = parseStringFlag(argv, i, arg); i++; break;
      case "--database": database = parseStringFlag(argv, i, arg); i++; break;
      case "--subscription": subscription = parseStringFlag(argv, i, arg); i++; break;
      case "--out": outDir = parseStringFlag(argv, i, arg); i++; break;
      case "--docker": forceDocker = true; break;
      case "--via-kubectl": viaKubectl = true; break;
      case "--kube-context": kubeContext = parseStringFlag(argv, i, arg); i++; break;
      case "--namespace": kubeNamespace = parseStringFlag(argv, i, arg); i++; break;
      case "--": break;
      case "-h":
      case "--help": help = true; break;
      default: throw new CosmosCliError(`unknown argument: ${arg}`, 2);
    }
  }

  const preset = help ? { env: envName, account: account || "", resourceGroup: resourceGroup || "", database: database || "" } : resolvePreset(envName, { account, resourceGroup, database });
  return { ...preset, subscription, forceDocker, viaKubectl, kubeContext, kubeNamespace, outDir: outDir || undefined, help };
}

export function parseDumpLog(log: string, database: string): Record<string, number> {
  const escaped = database.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(`done dumping ${escaped}\\.(\\S+) \\((\\d+) document`);
  const counts: Record<string, number> = {};
  for (const line of log.split("\n")) {
    const match = rx.exec(line);
    if (match) {
      counts[match[1]] = Number.parseInt(match[2], 10);
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export interface VerificationDiff {
  missing: string[];
  extra: string[];
  totalDocuments: number;
  collectionsDumped: number;
}

export function diffDumpVerification(expectedCollections: string[], dumpedCounts: Record<string, number>): VerificationDiff {
  const expected = new Set(expectedCollections);
  const dumped = new Set(Object.keys(dumpedCounts));
  const missing = [...expected].filter((name) => !dumped.has(name)).sort();
  const extra = [...dumped].filter((name) => !expected.has(name)).sort();
  return {
    missing,
    extra,
    totalDocuments: Object.values(dumpedCounts).reduce((sum, count) => sum + count, 0),
    collectionsDumped: dumped.size,
  };
}

export interface DumpManifest {
  env: string;
  account: string;
  resourceGroup: string;
  database: string;
  utc: string;
  gitSha: string;
  archive: string;
  archiveSha256: string;
  tool: string;
  expectedCollections: string[];
  dumpedCounts: Record<string, number>;
  totalDocuments: number;
  collectionsDumped: number;
  missingCollections: string[];
}

export function buildManifest(input: Omit<DumpManifest, "expectedCollections" | "dumpedCounts" | "totalDocuments" | "collectionsDumped" | "missingCollections"> & { expectedCollections: string[]; dumpedCounts: Record<string, number> }): DumpManifest {
  const expectedCollections = [...input.expectedCollections].sort();
  const dumpedCounts = Object.fromEntries(Object.entries(input.dumpedCounts).sort(([a], [b]) => a.localeCompare(b)));
  const diff = diffDumpVerification(expectedCollections, dumpedCounts);
  return {
    env: input.env,
    account: input.account,
    resourceGroup: input.resourceGroup,
    database: input.database,
    utc: input.utc,
    gitSha: input.gitSha,
    archive: input.archive,
    archiveSha256: input.archiveSha256,
    tool: input.tool,
    expectedCollections,
    dumpedCounts,
    totalDocuments: diff.totalDocuments,
    collectionsDumped: diff.collectionsDumped,
    missingCollections: diff.missing,
  };
}

function runnerDescription(runner: Runner, kubeContext: string, kubeNamespace: string): string {
  if (runner === "kubectl") return `kubectl (${kubeContext || "current-context"}, ns:${kubeNamespace}, ${DOCKER_IMAGE})`;
  if (runner === "native") return `native (${mongoToolVersion("mongodump")})`;
  return `docker (${DOCKER_IMAGE})`;
}

function manifestTool(runner: Runner, kubeNamespace: string): string {
  if (runner === "kubectl") return `kubectl:${DOCKER_IMAGE} (ns:${kubeNamespace})`;
  if (runner === "docker") return `docker:${DOCKER_IMAGE}`;
  return `native:${mongoToolVersion("mongodump")}`;
}

async function runDump(runner: Runner, uriDb: string, archive: string, log: string, dest: string, pod: string, opts: DumpOptions): Promise<number> {
  if (runner === "kubectl") {
    return runBinaryToFiles({
      command: "kubectl",
      args: [...kubeContextArgs(opts.kubeContext), "exec", "-i", pod, "-n", opts.kubeNamespace, "--", "sh", "-c", "read MURI; exec mongodump --uri \"$MURI\" --gzip --archive --numParallelCollections=1"],
      input: uriDb,
      stdoutPath: archive,
      stderrPath: log,
    });
  }
  if (runner === "docker") {
    return runStreamingCommand({
      command: "docker",
      args: ["run", "--rm", "--env", "MURI", "-e", `ARC=/dump/${archiveBase(archive)}`, "-v", `${dest}:/dump`, DOCKER_IMAGE, "sh", "-c", "mongodump --uri \"$MURI\" --gzip --archive=\"$ARC\" --numParallelCollections=1"],
      env: { ...process.env, MURI: uriDb },
      logPath: log,
    });
  }
  return runStreamingCommand({
    command: "mongodump",
    args: ["--uri", uriDb, "--gzip", `--archive=${archive}`, "--numParallelCollections=1"],
    logPath: log,
  });
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }

  const root = repoRoot();
  const outDir = opts.outDir || join(root, ".backups", "cosmos");
  let kubePod = "";

  try {
    azPreflight(opts.subscription);
    const runner = resolveRunnerOrThrow({ viaKubectl: opts.viaKubectl, forceDocker: opts.forceDocker, toolName: "mongodump", kubeNamespace: opts.kubeNamespace, kubeContext: opts.kubeContext });

    console.log("=== Cosmos DB dump ===");
    console.log(`  Env:            ${opts.env}`);
    console.log(`  Account:        ${opts.account} (rg: ${opts.resourceGroup})`);
    console.log(`  Database:       ${opts.database}`);
    console.log(`  Runner:         ${runnerDescription(runner, opts.kubeContext, opts.kubeNamespace)}`);
    console.log(`  Output dir:     ${outDir}`);
    console.log("");

    const uri = readCosmosConnectionString(opts.account, opts.resourceGroup);
    const uriDb = uriWithDb(uri, opts.database);
    const expectedCollections = listCosmosCollections(opts.account, opts.resourceGroup, opts.database);
    console.log(`  Collections reported by Cosmos: ${expectedCollections.length}`);

    const ts = timestampUtc();
    const dest = join(outDir, opts.account);
    await mkdir(dest, { recursive: true });
    const archive = join(dest, `${opts.database}-${ts}.archive.gz`);
    const log = `${archive}.log`;
    const manifestPath = `${archive}.manifest.json`;

    if (runner === "kubectl") {
      kubePod = kubePodUp({ prefix: "cosmos-dump", namespace: opts.kubeNamespace, kubeContext: opts.kubeContext });
    }

    console.log("");
    console.log(`  Dumping to ${archive} ...`);
    let attempt = 1;
    while (true) {
      const rc = await runDump(runner, uriDb, archive, log, dest, kubePod, opts);
      if (rc === 0) break;
      const logContent = await readFile(log, "utf-8").catch(() => "");
      if (/16500|TooManyRequests|429|RequestRateTooLarge/i.test(logContent)) {
        console.error("ERROR: mongodump hit RU throttling (429).");
      }
      if (attempt >= MAX_RETRIES) {
        throw new CosmosCliError(`mongodump failed after ${attempt} attempt(s) (exit ${rc}). See ${log}`, rc);
      }
      const backoff = attempt * 5;
      console.error(`ERROR: mongodump failed (exit ${rc}); retrying in ${backoff}s (${attempt}/${MAX_RETRIES})...`);
      await new Promise((resolve) => setTimeout(resolve, backoff * 1000));
      attempt++;
    }

    await assertNonEmptyFile(archive);
    const sha = await sha256File(archive);
    const logContent = await readFile(log, "utf-8").catch(() => "");
    const dumpedCounts = parseDumpLog(logContent, opts.database);
    const manifest = buildManifest({
      env: opts.env,
      account: opts.account,
      resourceGroup: opts.resourceGroup,
      database: opts.database,
      utc: ts,
      gitSha: gitSha(root),
      archive: archiveBase(archive),
      archiveSha256: sha,
      tool: manifestTool(runner, opts.kubeNamespace),
      expectedCollections,
      dumpedCounts,
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    console.log(`  Collections dumped: ${manifest.collectionsDumped}  documents: ${manifest.totalDocuments}`);
    const diff = diffDumpVerification(expectedCollections, dumpedCounts);
    if (diff.extra.length > 0) {
      console.log(`  Note: dumped but not in Cosmos listing: ${diff.extra.join(", ")}`);
    }
    let verifyRc = 0;
    if (diff.missing.length > 0) {
      console.error(`  FAIL: live collections missing from dump: ${diff.missing.join(", ")}`);
      verifyRc = 1;
    }
    if (!(await gzipIntegrityOk(archive))) {
      console.error(`ERROR: verification failed: archive did not pass gzip integrity check (${archive})`);
      verifyRc = 1;
    }

    console.log("");
    console.log(verifyRc === 0 ? "=== PASS ===" : "=== VERIFY FAILED (see logs) ===");
    console.log(`  Archive:  ${archive}`);
    console.log(`  Manifest: ${manifestPath}`);
    console.log(`  SHA256:   ${sha}`);
    console.log("");
    console.log("  To preview a restore from this archive:");
    console.log(`    pnpm db:restore -- --env ${opts.env} --archive "${archive}"`);
    if (verifyRc !== 0) process.exitCode = verifyRc;
  } finally {
    if (kubePod) kubePodDelete(kubePod, opts.kubeNamespace, opts.kubeContext);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    if (err instanceof CosmosCliError) {
      for (const line of err.message.split("\n")) console.error(`ERROR: ${line}`);
      process.exit(err.exitCode);
    }
    console.error(err);
    process.exit(1);
  });
}
