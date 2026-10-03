// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * generate-notice.ts — (re)build the repository-root NOTICE file for the
 * third-party open source software redistributed by Scope.
 *
 * This script ONLY orchestrates purpose-built license tooling and concatenates
 * their output. It never authors, summarizes, or edits any license text:
 *
 *   * npm   — `generate-license-file` extracts the verbatim LICENSE text of
 *             every production dependency of the pnpm workspace. It is run as a
 *             pinned CLI via `npx` (not a workspace dependency) so it never
 *             touches the lockfile; this script writes its config as JSON.
 *   * cargo — `cargo-about` extracts the verbatim license text of every crate
 *             that compiles into the shipped `gateway` binary
 *             (config: apps/gateway/about.toml, template: apps/gateway/about.hbs).
 *
 * The only human-written content is the header (scripts/notice-header.txt) and
 * the review preamble (in buildReview() below). Packages that are not OSS are
 * excluded from NOTICE and listed in NOTICE-REVIEW.txt for manual / CELA review.
 *
 * Usage:
 *   pnpm notice            Regenerate NOTICE and NOTICE-REVIEW.txt.
 *   pnpm notice:check      Verify the committed files are up to date (non-zero
 *                          exit if stale); writes nothing.
 *
 * Environment:
 *   SKIP_CARGO=1   Reuse the cached Rust section instead of re-running
 *                  cargo-about (cargo metadata resolution is slow). Requires a
 *                  prior full run to populate the cache.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const SEP = "=".repeat(79);
// generate-license-file is pinned exactly: a different version can regroup
// packages or change formatting, which would make the `pnpm notice:check` gate
// drift. Bump deliberately and regenerate when upgrading.
const GLF_VERSION = "4.2.1";
const log = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

type Mode = "generate" | "check";

const arg = process.argv[2];
let mode: Mode = "generate";
if (arg === "--check") {
  mode = "check";
} else if (arg) {
  log(`generate-notice: unknown argument '${arg}' (expected --check or none)`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// npm orchestration config (which packages to scan / skip / disambiguate).
//
// This is ORCHESTRATION ONLY. It never contains or authors any license text:
// every attribution in NOTICE is extracted verbatim by generate-license-file
// from each dependency's own LICENSE file under node_modules.
// ---------------------------------------------------------------------------

// Packages deliberately kept OUT of the auto-generated OSS NOTICE body.
//
// (1) @github/copilot and its per-platform binaries are the GitHub Copilot CLI,
//     which is PROPRIETARY (the "GitHub Copilot CLI License", not an OSS
//     license). The regex matches the main package AND all eight per-platform
//     binaries it publishes as optionalDependencies —
//     @github/copilot-<os>-<arch> for os ∈ {linux, linuxmusl, darwin, win32}
//     and arch ∈ {x64, arm64} (the `linuxmusl-*` variants ship in the
//     Alpine-based worker images). They are enumerated separately in
//     NOTICE-REVIEW.txt for manual / CELA determination.
//     NOTE: @github/copilot-sdk is a genuine MIT package and is intentionally
//     NOT matched by this pattern, so it stays in the OSS NOTICE.
//
// (2) Platform-gated native binaries are excluded so the generated NOTICE is
//     byte-identical on every OS/arch. pnpm only installs the one optional
//     binary matching the current platform, so without this the output — and
//     therefore the deterministic `pnpm notice:check` CI gate — would differ
//     per machine.
//       * @os-theme/<platform> — per-platform native addon of `os-theme`. It
//         ships NO license file of its own; the parent `os-theme` package (MIT)
//         is kept in NOTICE and carries the verbatim license text. `os-theme`
//         is pulled in only by the proprietary @github/copilot bundle (itself
//         under CELA review).
//       * fsevents — macOS-only (package.json `os: ["darwin"]`); it is NOT
//         present in the shipped Linux container images, so it is not
//         redistributed there and needs no attribution. Excluding it keeps the
//         NOTICE OS-independent.
const exclude = [
  "/^@github\\/copilot(-(linux|linuxmusl|darwin|win32)-(x64|arm64))?(@.*)?$/",
  "/^@os-theme\\/[^/]+(@.*)?$/",
  "/^fsevents(@.*)?$/",
];

/**
 * Locate an unscoped package's install directory in the pnpm store and return
 * its version plus the absolute path to a given license filename, if present.
 */
function resolvePnpmLicense(
  pkgName: string,
  licenseFileName: string,
): { version: string; licensePath: string } | null {
  const results = resolvePnpmLicenses(pkgName, licenseFileName);
  return results.length > 0 ? results[0] : null;
}

/**
 * Like resolvePnpmLicense but returns ALL installed versions of `pkgName`
 * that ship the given `licenseFileName`.
 */
function resolvePnpmLicenses(
  pkgName: string,
  licenseFileName: string,
): { version: string; licensePath: string }[] {
  const store = join(repoRoot, "node_modules", ".pnpm");
  if (!existsSync(store)) return [];
  const prefix = `${pkgName}@`;
  const results: { version: string; licensePath: string }[] = [];
  for (const entry of readdirSync(store)) {
    // Match "<name>@<version>" exactly (avoid e.g. "qrcode@..." for "qr").
    if (!entry.startsWith(prefix) || !/^[^@]+@\d/.test(entry)) continue;
    const pkgDir = join(store, entry, "node_modules", pkgName);
    const licensePath = join(pkgDir, licenseFileName);
    if (existsSync(licensePath)) {
      // Version is the store-entry segment after "<name>@", minus any pnpm
      // peer-dependency suffix in parentheses.
      const version = entry.slice(prefix.length).replace(/\(.*$/, "");
      results.push({ version, licensePath });
    }
  }
  return results;
}

// Disambiguate packages that ship MORE THAN ONE license file. generate-license-file
// refuses to guess so it does not silently pick the wrong text. We resolve each
// case by pointing the tool at ONE of the package's OWN real license files —
// never at hand-written text.
//
// Currently known multi-license packages:
//  - `qr`: published under "(MIT OR Apache-2.0)", ships LICENSE (Apache-2.0) and
//    LICENSE-MIT. We elect the MIT arm.
//  - `import-in-the-middle`: ships LICENSE (Apache-2.0) and LICENSE-3rdparty.csv.
//    We use the LICENSE file.
//
// If a future dependency introduces another multi-license package, generate-license-file
// fails under `--ci`; add a corresponding entry here pointing at that package's own file.
const replace: Record<string, string> = {};
const qr = resolvePnpmLicense("qr", "LICENSE-MIT");
if (qr) replace[`qr@${qr.version}`] = qr.licensePath;
const iitm = resolvePnpmLicenses("import-in-the-middle", "LICENSE");
for (const entry of iitm) replace[`import-in-the-middle@${entry.version}`] = entry.licensePath;

// ---------------------------------------------------------------------------
// NOTICE-REVIEW.txt: production packages pnpm cannot classify as a known OSS
// license (its "Unknown" bucket). They are excluded from the OSS NOTICE and
// require manual / legal (CELA) determination before the open source release.
//
// This authors NO license text. It reads the machine output of
//   pnpm licenses list --prod --json
// and prints only mechanically-extracted metadata plus pointers to the license
// file each package bundles, so a reviewer can read the real terms.
// ---------------------------------------------------------------------------

interface PnpmLicensePackage {
  name: string;
  versions: string[];
  paths: string[];
  license: string;
  author?: string;
  homepage?: string;
  description?: string;
}

// pnpm reports whichever per-platform native binary is installed on THIS machine
// (e.g. @github/copilot-darwin-arm64 on macOS, @github/copilot-linux-x64 on the
// Linux CI runner, @github/copilot-linuxmusl-x64 in the Alpine images). Listing
// that machine-specific package here would make this file differ per platform and
// break `pnpm notice:check`. We therefore drop the per-platform binaries from the
// listing and instead enumerate them from their parent package's
// `optionalDependencies`, which is identical on every platform.
const PLATFORM_BINARY = /-(linux|linuxmusl|darwin|win32)-(x64|arm64)$/;

const rel = (p: string): string => relative(repoRoot, p) || p;

function licenseFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => /^(LICEN[CS]E|COPYING|NOTICE|UNLICENSE|PATENTS)/i.test(f))
      .sort();
  } catch {
    return [];
  }
}

// Enumerate a package's own per-platform binary optionalDependencies (name@range),
// read verbatim from its package.json — reproducible regardless of host platform.
function platformBinaries(dir: string): string[] {
  try {
    const pj = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    ) as { optionalDependencies?: Record<string, string> };
    const od = pj.optionalDependencies ?? {};
    return Object.keys(od)
      .filter((n) => PLATFORM_BINARY.test(n))
      .sort()
      .map((n) => `${n}@${od[n]}`);
  } catch {
    return [];
  }
}

function buildReview(): string {
  // spawn pnpm and capture stdout regardless of exit code / stderr noise.
  const raw = execFileSync(
    "pnpm",
    ["licenses", "list", "--prod", "--json"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
  );

  let data: Record<string, PnpmLicensePackage[]> = {};
  try {
    data = JSON.parse(raw) as Record<string, PnpmLicensePackage[]>;
  } catch (err) {
    log(`notice-review: could not parse pnpm JSON: ${(err as Error).message}`);
    process.exit(1);
  }

  const unknown = (data["Unknown"] ?? []).filter(
    (p) => !PLATFORM_BINARY.test(p.name),
  );

  const out: string[] = [];
  out.push("Scope - PACKAGES REQUIRING MANUAL / LEGAL (CELA) REVIEW");
  out.push("");
  out.push(
    "The production packages listed below could not be matched to a known open",
  );
  out.push(
    "source license by `pnpm licenses list --prod --json` (they fall in its",
  );
  out.push(
    '"Unknown" bucket). They are deliberately EXCLUDED from the attributions in',
  );
  out.push(
    "NOTICE and must be reviewed manually before the open source release. Read the",
  );
  out.push(
    "bundled license file referenced for each package to determine the real terms;",
  );
  out.push("this file intentionally does not reproduce or summarize those terms.");
  out.push("");
  out.push("Each package's per-platform native binaries are listed from its own");
  out.push("optionalDependencies (identical on every OS/arch) instead of by whichever");
  out.push("binary is installed on this machine, so this listing is reproducible in CI.");
  out.push("");
  out.push("=".repeat(79));
  out.push("");

  if (unknown.length === 0) {
    out.push("No production packages currently require manual review.");
  } else {
    for (const pkg of unknown
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))) {
      for (const version of pkg.versions) {
        out.push(`- ${pkg.name}@${version}`);
        if (pkg.author) out.push(`    Publisher:   ${pkg.author}`);
        if (pkg.homepage) out.push(`    Homepage:    ${pkg.homepage}`);
        if (pkg.description) out.push(`    Description: ${pkg.description}`);
        out.push(`    Declared "license" (package.json): ${pkg.license}`);
        for (const p of pkg.paths ?? []) {
          out.push(`    Install path:             ${rel(p)}`);
          const files = licenseFiles(p);
          if (files.length) {
            out.push(`    Bundled license file(s):  ${files.join(", ")}`);
          } else {
            out.push("    Bundled license file(s):  (none found)");
          }
        }
        const bins = (pkg.paths ?? []).flatMap(platformBinaries);
        if (bins.length) {
          out.push(
            "    Per-platform native binaries (optionalDependencies; each ships",
          );
          out.push("    the same proprietary license — review it too):");
          for (const b of [...new Set(bins)].sort()) out.push(`      - ${b}`);
        }
        out.push("");
      }
    }
  }

  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const buildDir = join(repoRoot, ".notice-build");
  mkdirSync(buildDir, { recursive: true });
  const rustCache = join(buildDir, "NOTICE-rust.txt");

  log(
    "==> [1/4] npm: extracting production license texts with generate-license-file",
  );
  const jsOut = join(buildDir, "NOTICE-js.txt");
  // Config is emitted as JSON (a format generate-license-file accepts natively)
  // so the exclude/replace orchestration lives in this one TypeScript file
  // instead of a separate committed config module. The `replace` entry points
  // the tool at qr's own LICENSE-MIT (resolved above) — never at authored text.
  const glfConfig = join(buildDir, "glf.config.json");
  writeFileSync(
    glfConfig,
    `${JSON.stringify(
      {
        inputs: [join(repoRoot, "package.json")],
        exclude,
        replace,
        omitVersions: false,
      },
      null,
      2,
    )}\n`,
  );
  // Pinned exactly for reproducibility: a different generate-license-file version
  // can regroup packages or change formatting, which would make `--check` (CI)
  // drift. Run via npx as a standalone CLI so it is NOT a workspace dependency
  // and never perturbs the lockfile.
  execFileSync(
    "npx",
    [
      "--yes",
      `generate-license-file@${GLF_VERSION}`,
      "--config",
      glfConfig,
      "--output",
      jsOut,
      "--overwrite",
      "--ci",
      "--no-spinner",
    ],
    { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] },
  );
  const jsText = readFileSync(jsOut, "utf8");

  log(
    "==> [2/4] cargo: extracting gateway crate license texts with cargo-about",
  );
  let rustText: string;
  if (process.env.SKIP_CARGO === "1") {
    if (!existsSync(rustCache)) {
      log("generate-notice: SKIP_CARGO=1 but no cached Rust section exists.");
      log(`Run once without SKIP_CARGO to populate ${rustCache}.`);
      process.exit(1);
    }
    log(`    SKIP_CARGO=1 — reusing cached ${rustCache}`);
    rustText = readFileSync(rustCache, "utf8");
  } else {
    rustText = execFileSync("cargo", ["about", "generate", "about.hbs"], {
      cwd: join(repoRoot, "apps", "gateway"),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    writeFileSync(rustCache, rustText);
  }

  log("==> [3/4] assembling NOTICE");
  const header = readFileSync(
    join(repoRoot, "scripts", "notice-header.txt"),
    "utf8",
  );
  const notice =
    `${header}\n\n` +
    `${SEP}\n` +
    "npm packages (production dependencies)\n" +
    `${SEP}\n\n` +
    `${jsText}\n\n` +
    `${SEP}\n` +
    "Rust crates (gateway binary)\n" +
    `${SEP}\n\n` +
    rustText;

  log(
    "==> [4/4] building NOTICE-REVIEW.txt (packages needing manual / CELA review)",
  );
  const review = buildReview();

  if (mode === "check") {
    let status = 0;
    if (!bytesEqual(join(repoRoot, "NOTICE"), notice)) {
      log("NOTICE is out of date. Run 'pnpm notice' and commit the result.");
      status = 1;
    }
    if (!bytesEqual(join(repoRoot, "NOTICE-REVIEW.txt"), review)) {
      log(
        "NOTICE-REVIEW.txt is out of date. Run 'pnpm notice' and commit the result.",
      );
      status = 1;
    }
    if (status === 0) {
      log("NOTICE and NOTICE-REVIEW.txt are up to date.");
    }
    process.exit(status);
  }

  writeFileSync(join(repoRoot, "NOTICE"), notice);
  writeFileSync(join(repoRoot, "NOTICE-REVIEW.txt"), review);
  log(
    `Wrote ${notice.split("\n").length} lines to NOTICE and ${review.split("\n").length} lines to NOTICE-REVIEW.txt.`,
  );
}

/** True when the committed file at `path` is byte-identical to `content`. */
function bytesEqual(path: string, content: string): boolean {
  if (!existsSync(path)) return false;
  return readFileSync(path).equals(Buffer.from(content, "utf8"));
}

main().catch((err: unknown) => {
  log(`generate-notice: ${(err as Error).stack ?? String(err)}`);
  process.exit(1);
});
