#!/usr/bin/env npx tsx
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// =============================================================================
// cosmos-restore.ts - Restore a Cosmos DB for MongoDB database from an archive
// =============================================================================
// Safe by default:
//   - DRY RUN unless --execute is given (nothing is written)
//   - restores into a NEW database (<database>-restore-<UTC>) so live
//     collections and their Cosmos shard keys are never touched
// =============================================================================

import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, readFile, stat } from "node:fs/promises";
import {
  archiveBase,
  azPreflight,
  CosmosCliError,
  DOCKER_IMAGE,
  fileExists,
  kubeContextArgs,
  kubePodDelete,
  kubePodUp,
  parseStringFlag,
  readCosmosConnectionString,
  repoRoot,
  resolvePreset,
  resolveRunnerOrThrow,
  runStreamingCommand,
  sha256File,
  timestampUtc,
  type ResolvedPreset,
  type Runner,
} from "./shared.js";

export interface RestoreOptions extends ResolvedPreset {
  toDatabase: string;
  archive: string;
  subscription: string;
  outDir?: string;
  batchSize: string;
  forceDocker: boolean;
  viaKubectl: boolean;
  kubeContext: string;
  kubeNamespace: string;
  execute: boolean;
  inPlace: boolean;
  forceDrop: boolean;
  assumeYes: boolean;
  help: boolean;
}

export function usage(): string {
  return `=============================================================================
cosmos-restore.ts - Restore a Cosmos DB for MongoDB database from an archive
=============================================================================
Safe by default:
  - DRY RUN unless --execute is given (nothing is written)
  - restores into a NEW database (<database>-restore-<UTC>) so live
    collections and their Cosmos shard keys are never touched

Usage:
  pnpm db:restore                                  # dry-run, latest int2 archive
  pnpm db:restore -- --archive path/to.archive.gz  # dry-run a specific archive
  pnpm db:restore -- --execute                     # restore into a NEW db
  pnpm db:restore -- --execute --to-database scope-mt-recovered
  pnpm db:restore -- --execute --in-place          # write back into the source db (no drop)
  pnpm db:restore -- --execute --in-place --force-drop   # DANGER: drop+recreate collections
  pnpm db:restore -- --env int --via-kubectl       # run inside the cluster VNet
                                                   # (required: Cosmos is private-only)
  pnpm db:restore -- --execute --batch-size 1      # pace inserts to dodge Cosmos RU 429s

Prerequisites:
  - Azure CLI logged in (az login) with access to the target account
  - To reach the DB, one of:
      * --via-kubectl: a kubectl context whose cluster VNet has the private
        endpoint for the target account (Scope Cosmos is publicNetworkAccess
        Disabled), OR
      * a network already allowed to reach the account, plus 'mongorestore'
        on PATH (brew install mongodb-database-tools) or Docker running
        (falls back to the mongo:4.2 image)

Cosmos caveats:
  - Restoring into a NEW database relies on implicit collection creation. If
    the account disallows it, pre-provision the target collections first.
  - Large collections can trip RU throttling (server error 16500 / 429) on
    serverless or low-RU accounts. mongorestore does not honour Cosmos'
    RetryAfterMs, so pass --batch-size 1 (or a small value) to pace inserts.
    Restore inserts documents (it does not upsert), so re-running over an
    already-populated target logs duplicate-key errors for existing _ids;
    prefer dropping the target db and restoring once with --batch-size.
  - --force-drop deletes and recreates collections; a Cosmos collection's
    shard key is defined via the control plane and can be lost. Re-create
    the collection with its shard key afterwards if used.
=============================================================================`;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RestoreOptions {
  let envName = env.SCOPE_ENV || "int2";
  let account = "";
  let resourceGroup = "";
  let database = "";
  let toDatabase = "";
  let archive = "";
  let subscription = "";
  let outDir = env.BACKUP_DIR || "";
  let batchSize = "";
  let forceDocker = false;
  let viaKubectl = false;
  let kubeContext = "";
  let kubeNamespace = "default";
  let execute = false;
  let inPlace = false;
  let forceDrop = false;
  let assumeYes = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--env": envName = parseStringFlag(argv, i, arg); i++; break;
      case "--account": account = parseStringFlag(argv, i, arg); i++; break;
      case "--resource-group": resourceGroup = parseStringFlag(argv, i, arg); i++; break;
      case "--database": database = parseStringFlag(argv, i, arg); i++; break;
      case "--to-database": toDatabase = parseStringFlag(argv, i, arg); i++; break;
      case "--archive": archive = parseStringFlag(argv, i, arg); i++; break;
      case "--subscription": subscription = parseStringFlag(argv, i, arg); i++; break;
      case "--out": outDir = parseStringFlag(argv, i, arg); i++; break;
      case "--batch-size": batchSize = parseStringFlag(argv, i, arg); i++; break;
      case "--docker": forceDocker = true; break;
      case "--via-kubectl": viaKubectl = true; break;
      case "--kube-context": kubeContext = parseStringFlag(argv, i, arg); i++; break;
      case "--namespace": kubeNamespace = parseStringFlag(argv, i, arg); i++; break;
      case "--execute": execute = true; break;
      case "--in-place": inPlace = true; break;
      case "--force-drop": forceDrop = true; break;
      case "-y":
      case "--yes": assumeYes = true; break;
      case "--": break;
      case "-h":
      case "--help": help = true; break;
      default: throw new CosmosCliError(`unknown argument: ${arg}`, 2);
    }
  }

  const preset = help ? { env: envName, account: account || "", resourceGroup: resourceGroup || "", database: database || "" } : resolvePreset(envName, { account, resourceGroup, database });
  return { ...preset, toDatabase, archive, subscription, outDir: outDir || undefined, batchSize, forceDocker, viaKubectl, kubeContext, kubeNamespace, execute, inPlace, forceDrop, assumeYes, help };
}

export interface ArchiveCandidate {
  path: string;
  mtimeMs: number;
}

export function pickNewestArchive(candidates: ArchiveCandidate[]): string | undefined {
  return [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path;
}

export function checkForceDropGuardrail(forceDrop: boolean, inPlace: boolean): void {
  if (forceDrop && !inPlace) {
    throw new CosmosCliError("--force-drop only makes sense with --in-place. Aborting.", 2);
  }
}

export interface RestoreArgOptions {
  database: string;
  targetDatabase: string;
  execute: boolean;
  forceDrop: boolean;
  batchSize: string;
}

export function buildRestoreArgs(opts: RestoreArgOptions): string[] {
  const args = [
    "--gzip",
    "--numParallelCollections=1",
    "--numInsertionWorkersPerCollection=1",
    `--nsInclude=${opts.database}.*`,
    `--nsFrom=${opts.database}.*`,
    `--nsTo=${opts.targetDatabase}.*`,
  ];
  if (opts.batchSize) args.push(`--batchSize=${opts.batchSize}`);
  if (!opts.execute) args.push("--dryRun");
  if (opts.forceDrop) args.push("--drop");
  return args;
}

interface ManifestShape {
  archiveSha256?: string;
}

function parseManifest(raw: string): ManifestShape {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed === "object" && parsed !== null) {
    const archiveSha256 = "archiveSha256" in parsed && typeof parsed.archiveSha256 === "string" ? parsed.archiveSha256 : undefined;
    return { archiveSha256 };
  }
  return {};
}

async function latestArchive(outDir: string, account: string, database: string): Promise<string | undefined> {
  const dir = join(outDir, account);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  const candidates: ArchiveCandidate[] = [];
  for (const name of names) {
    if (!name.startsWith(`${database}-`) || !name.endsWith(".archive.gz")) continue;
    const path = join(dir, name);
    const s = await stat(path);
    if (s.isFile()) candidates.push({ path, mtimeMs: s.mtimeMs });
  }
  return pickNewestArchive(candidates);
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function confirm(question: string, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) return true;
  return (await ask(question)) === "yes";
}

async function runRestore(runner: Runner, uri: string, archive: string, rargs: string[], rlog: string, pod: string, opts: RestoreOptions): Promise<number> {
  if (runner === "kubectl") {
    const cp = await runStreamingCommand({
      command: "kubectl",
      args: [...kubeContextArgs(opts.kubeContext), "cp", archive, `${opts.kubeNamespace}/${pod}:/tmp/restore.gz`],
      logPath: rlog,
    });
    if (cp !== 0) {
      console.error("ERROR: failed to copy archive into the pod.");
      return 1;
    }
    return runStreamingCommand({
      command: "kubectl",
      args: [...kubeContextArgs(opts.kubeContext), "exec", "-i", pod, "-n", opts.kubeNamespace, "--", "sh", "-c", "read MURI; exec mongorestore --uri \"$MURI\" --archive=/tmp/restore.gz \"$@\"", "_", ...rargs],
      input: uri,
      logPath: rlog,
    });
  }
  if (runner === "docker") {
    return runStreamingCommand({
      command: "docker",
      args: ["run", "--rm", "--env", "MURI", "-e", `ARCHIVE_BASE=${archiveBase(archive)}`, "-v", `${dirname(archive)}:/dump`, DOCKER_IMAGE, "sh", "-c", "exec mongorestore --uri \"$MURI\" --archive=\"/dump/$ARCHIVE_BASE\" \"$@\"", "_", ...rargs],
      env: { ...process.env, MURI: uri },
      logPath: rlog,
    });
  }
  return runStreamingCommand({ command: "mongorestore", args: ["--uri", uri, `--archive=${archive}`, ...rargs], logPath: rlog });
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }

  const root = repoRoot();
  const outDir = opts.outDir || join(root, ".backups", "cosmos");
  const ts = timestampUtc();
  const archive = opts.archive || await latestArchive(outDir, opts.account, opts.database) || "";
  if (!archive || !(await fileExists(archive))) {
    throw new CosmosCliError(`no archive found. Pass --archive <file> or run 'pnpm db:dump' first.\nsearched: ${join(outDir, opts.account, `${opts.database}-*.archive.gz`)}`, 1);
  }
  const targetDatabase = opts.inPlace ? opts.database : (opts.toDatabase || `${opts.database}-restore-${ts}`);

  azPreflight(opts.subscription);
  const runner = resolveRunnerOrThrow({ viaKubectl: opts.viaKubectl, forceDocker: opts.forceDocker, toolName: "mongorestore", kubeNamespace: opts.kubeNamespace, kubeContext: opts.kubeContext });

  const manifestPath = `${archive}.manifest.json`;
  if (await fileExists(manifestPath)) {
    const manifest = parseManifest(await readFile(manifestPath, "utf-8"));
    const got = await sha256File(archive);
    if (manifest.archiveSha256 && manifest.archiveSha256 !== got) {
      throw new CosmosCliError(`archive sha256 does not match its manifest. Refusing to proceed.\n  manifest: ${manifest.archiveSha256}\n  archive:  ${got}`, 1);
    }
  }

  const mode = opts.execute ? "EXECUTE (writes data)" : "DRY RUN (no writes)";
  const dropDesc = opts.forceDrop ? "YES - collections dropped then recreated" : "no (documents inserted; existing _ids skipped as duplicates)";
  console.log("=== Cosmos DB restore ===");
  console.log(`  Mode:           ${mode}`);
  console.log(`  Account:        ${opts.account} (rg: ${opts.resourceGroup})`);
  console.log(`  Archive:        ${archive}`);
  console.log(`  Source db:      ${opts.database}`);
  console.log(`  Target db:      ${targetDatabase}${opts.inPlace ? "  (in-place)" : "  (new database)"}`);
  console.log(`  Drop first:     ${dropDesc}`);
  console.log(`  Runner:         ${runner}`);
  console.log("");

  checkForceDropGuardrail(opts.forceDrop, opts.inPlace);

  if (opts.execute) {
    if (opts.inPlace) {
      console.error(`!! This will WRITE into the LIVE database '${opts.database}' on '${opts.account}'.`);
      if (opts.forceDrop) {
        console.error("!! --force-drop will DROP each collection first. Cosmos shard-key");
        console.error("!! definitions may be lost; re-apply deploy manifests afterwards.");
      }
      if (!(await confirm("Type 'yes' to proceed:", opts.assumeYes))) throw new CosmosCliError("aborted.", 1);
    } else {
      console.error(`This will create and populate a NEW database '${targetDatabase}' on '${opts.account}'.`);
      if (!(await confirm("Type 'yes' to proceed:", opts.assumeYes))) throw new CosmosCliError("aborted.", 1);
    }
  }

  const uri = readCosmosConnectionString(opts.account, opts.resourceGroup);
  const rargs = buildRestoreArgs({ database: opts.database, targetDatabase, execute: opts.execute, forceDrop: opts.forceDrop, batchSize: opts.batchSize });
  const rlog = `${archive}.restore-${ts}.log`;
  let kubePod = "";
  try {
    if (runner === "kubectl") {
      kubePod = kubePodUp({ prefix: "cosmos-restore", namespace: opts.kubeNamespace, kubeContext: opts.kubeContext });
    }
    const rc = await runRestore(runner, uri, archive, rargs, rlog, kubePod, opts);
    console.log("");
    if (rc === 0) {
      if (opts.execute) {
        console.log("=== RESTORE COMPLETE ===");
        console.log(`  Restored into: ${targetDatabase} on ${opts.account}`);
      } else {
        console.log("=== DRY RUN OK (no data written) ===");
        console.log(`  Re-run with --execute to restore into '${targetDatabase}'.`);
      }
      console.log(`  Log: ${rlog}`);
    } else {
      console.error(`=== RESTORE FAILED (exit ${rc}) ===`);
      console.log(`  Log: ${rlog}`);
      process.exitCode = rc;
    }
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
