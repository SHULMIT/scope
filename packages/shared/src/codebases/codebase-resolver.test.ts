// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodebaseDocument, CodebaseRevisionDocument } from "../types/codebase.js";
import { buildCodebaseRevisionRef } from "./codebase-revision-id.js";
import { CodebaseResolver } from "./codebase-resolver.js";
import type { CodebaseRevisionStore, CreateCodebaseRevisionInput } from "./codebase-revision-store.js";

function makeTestWorkspace(name: string): string {
  const baseDir = join(dirname(fileURLToPath(import.meta.url)), ".test-artifacts");
  mkdirSync(baseDir, { recursive: true });
  const dir = join(baseDir, `${name}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTestWorkspace(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

async function makeTarGz(entries: Record<string, string>, opts?: { wrapperDir?: string }): Promise<Buffer> {
  const workspace = makeTestWorkspace("tar-input");
  try {
    const root = opts?.wrapperDir ? join(workspace, opts.wrapperDir) : workspace;
    mkdirSync(root, { recursive: true });
    for (const [relativePath, content] of Object.entries(entries)) {
      const fullPath = join(root, relativePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content);
    }

    const outPath = join(workspace, "archive.tar.gz");
    const tar = await import("tar");
    const topLevel = opts?.wrapperDir
      ? [opts.wrapperDir]
      : [...new Set(Object.keys(entries).map((path) => path.split("/")[0]))];
    await tar.create({ gzip: true, file: outPath, cwd: workspace }, topLevel);
    return readFileSync(outPath);
  } finally {
    cleanupTestWorkspace(workspace);
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  } as unknown as Response;
}

function arrayBufferResponse(buffer: Buffer): Response {
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: async () => arrayBuffer,
  } as unknown as Response;
}

function makeCodebase(overrides: Partial<CodebaseDocument> = {}): CodebaseDocument {
  return {
    _id: "codebase-1",
    projectId: "proj-test",
    slug: "pamelafox-site",
    name: "Pamela Fox Site",
    sourceType: "git",
    source: "pamelafox/site",
    revisionCounter: 0,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeStoreSpy() {
  let revisionNumber = 0;
  const revisions: CodebaseRevisionDocument[] = [];
  const createRevision = vi.fn(
    async (input: CreateCodebaseRevisionInput, opts?: { id?: string }): Promise<CodebaseRevisionDocument> => {
      revisionNumber += 1;
      const doc: CodebaseRevisionDocument = {
        ...input,
        _id: opts?.id ?? randomUUID(),
        projectId: "proj-test",
        revisionNumber,
        ref: buildCodebaseRevisionRef(input.slug, revisionNumber),
        createdAt: new Date(),
      };
      revisions.push(doc);
      return doc;
    }
  );
  const getLatest = vi.fn(async (codebaseId: string): Promise<CodebaseRevisionDocument | null> => {
    const matching = revisions.filter((r) => r.codebaseId === codebaseId);
    return matching.length ? matching[matching.length - 1] : null;
  });
  return {
    createRevision,
    getLatest,
    store: { createRevision, getLatest } as unknown as CodebaseRevisionStore,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CodebaseResolver", () => {
  it("resolves latest git refs, normalizes tarballs, uploads, and creates a revision", async () => {
    const tarball = await makeTarGz({ "package.json": "{}", "src/index.js": "console.log('ok');" }, { wrapperDir: "repo-main" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.test/repos/pamelafox/site") {
        return jsonResponse(200, { default_branch: "main" });
      }
      if (url === "https://api.github.test/repos/pamelafox/site/commits/main") {
        return jsonResponse(200, {
          sha: "abc123",
          commit: { committer: { date: "2024-01-01T00:00:00Z" } },
        });
      }
      if (url === "https://api.github.test/repos/pamelafox/site/tarball/abc123") {
        return arrayBufferResponse(tarball);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { createRevision, store } = makeStoreSpy();
    const uploadArchive = vi.fn(async (blobName: string) => `https://blob.test/${blobName}`);

    await new CodebaseResolver({ githubApiUrl: "https://api.github.test" }).resolveGit(
      makeCodebase(),
      "latest",
      store,
      uploadArchive,
      { creator: "tester" }
    );

    expect(createRevision).toHaveBeenCalledOnce();
    const [input, opts] = createRevision.mock.calls[0];
    expect(input).toMatchObject({
      codebaseId: "codebase-1",
      slug: "pamelafox-site",
      sourceType: "git",
      source: "pamelafox/site",
      requestedRef: "latest",
      resolvedCommitSha: "abc123",
      archiveUrl: expect.stringContaining("codebase-revisions/codebase-1/"),
      creator: "tester",
    });
    expect(input.commitTimestamp).toEqual(new Date("2024-01-01T00:00:00Z"));
    expect(input.fileCount).toBe(2);
    expect(input.sizeBytes).toBeGreaterThan(0);
    expect(opts?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(uploadArchive).toHaveBeenCalledOnce();
    const [blobName] = uploadArchive.mock.calls[0];
    expect(blobName).toBe(`codebase-revisions/codebase-1/${opts?.id}.tar.gz`);
  });

  it("creates archive revisions with content hashes and normalized archive metadata", async () => {
    const archive = await makeTarGz({ "README.md": "hello" });
    const { createRevision, store } = makeStoreSpy();
    const uploadArchive = vi.fn(async (blobName: string) => `https://blob.test/${blobName}`);

    await new CodebaseResolver().createArchiveRevision(
      makeCodebase({ sourceType: "archive", source: undefined }),
      { buffer: archive, originalFilename: "upload.tar.gz", creator: "tester" },
      store,
      uploadArchive
    );

    expect(createRevision).toHaveBeenCalledOnce();
    const [input] = createRevision.mock.calls[0];
    expect(input).toMatchObject({
      codebaseId: "codebase-1",
      slug: "pamelafox-site",
      sourceType: "archive",
      originalFilename: "upload.tar.gz",
      archiveUrl: expect.stringContaining("codebase-revisions/codebase-1/"),
      creator: "tester",
    });
    expect(input.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(input.fileCount).toBeGreaterThan(0);
    expect(input.sizeBytes).toBeGreaterThan(0);
  });

  it("deduplicates archive uploads with identical content hashes", async () => {
    const archive = await makeTarGz({ "README.md": "same-bytes" });
    const { createRevision, store } = makeStoreSpy();
    const uploadArchive = vi.fn(async (blobName: string) => `https://blob.test/${blobName}`);
    const resolver = new CodebaseResolver();
    const codebase = makeCodebase({ sourceType: "archive", source: undefined });

    const first = await resolver.createArchiveRevision(codebase, { buffer: archive }, store, uploadArchive);
    const second = await resolver.createArchiveRevision(codebase, { buffer: archive }, store, uploadArchive);

    expect(createRevision).toHaveBeenCalledTimes(1);
    expect(uploadArchive).toHaveBeenCalledTimes(1);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.revision._id).toBe(first.revision._id);
    expect(second.revision.revisionNumber).toBe(first.revision.revisionNumber);
  });

  it("creates a new archive revision when content hashes differ", async () => {
    const { createRevision, store } = makeStoreSpy();
    const uploadArchive = vi.fn(async (blobName: string) => `https://blob.test/${blobName}`);
    const resolver = new CodebaseResolver();
    const codebase = makeCodebase({ sourceType: "archive", source: undefined });

    const first = await resolver.createArchiveRevision(
      codebase,
      { buffer: await makeTarGz({ "README.md": "one" }) },
      store,
      uploadArchive
    );
    const second = await resolver.createArchiveRevision(
      codebase,
      { buffer: await makeTarGz({ "README.md": "two" }) },
      store,
      uploadArchive
    );

    expect(createRevision).toHaveBeenCalledTimes(2);
    expect(uploadArchive).toHaveBeenCalledTimes(2);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(false);
    expect(second.revision._id).not.toBe(first.revision._id);
    expect(second.revision.revisionNumber).toBe(first.revision.revisionNumber + 1);
  });

  it("deduplicates when resolving the same commit SHA twice", async () => {
    const tarball = await makeTarGz({ "README.md": "same" }, { wrapperDir: "repo-abc123" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.test/repos/pamelafox/site/commits/abc123") {
        return jsonResponse(200, {
          sha: "abc123",
          commit: { committer: { date: "2024-01-01T00:00:00Z" } },
        });
      }
      if (url === "https://api.github.test/repos/pamelafox/site/tarball/abc123") {
        return arrayBufferResponse(tarball);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { createRevision, store } = makeStoreSpy();
    const uploadArchive = vi.fn(async (blobName: string) => `https://blob.test/${blobName}`);
    const resolver = new CodebaseResolver({ githubApiUrl: "https://api.github.test" });
    const codebase = makeCodebase();

    const first = await resolver.resolveGit(codebase, "abc123", store, uploadArchive);
    const second = await resolver.resolveGit(codebase, "abc123", store, uploadArchive);

    // Second resolution reuses the existing revision: no new revision, no re-upload.
    expect(createRevision).toHaveBeenCalledTimes(1);
    expect(uploadArchive).toHaveBeenCalledTimes(1);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.revision._id).toBe(first.revision._id);
    expect(second.revision.revisionNumber).toBe(first.revision.revisionNumber);
  });

  it("creates a new revision when the resolved commit SHA changes", async () => {
    const tarball = await makeTarGz({ "README.md": "v" }, { wrapperDir: "repo-x" });
    let sha = "sha-one";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/commits/")) {
        return jsonResponse(200, { sha, commit: { committer: { date: "2024-01-01T00:00:00Z" } } });
      }
      if (url.includes("/tarball/")) {
        return arrayBufferResponse(tarball);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { createRevision, store } = makeStoreSpy();
    const uploadArchive = vi.fn(async (blobName: string) => `https://blob.test/${blobName}`);
    const resolver = new CodebaseResolver({ githubApiUrl: "https://api.github.test" });
    const codebase = makeCodebase();

    const first = await resolver.resolveGit(codebase, "main", store, uploadArchive);
    sha = "sha-two";
    const second = await resolver.resolveGit(codebase, "main", store, uploadArchive);

    expect(createRevision).toHaveBeenCalledTimes(2);
    expect(uploadArchive).toHaveBeenCalledTimes(2);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(false);
    expect(second.revision._id).not.toBe(first.revision._id);
    expect(second.revision.revisionNumber).toBe(first.revision.revisionNumber + 1);
  });
});
