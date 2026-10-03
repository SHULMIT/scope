// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerTaskPromptCommands } from "./task-prompt.js";

function makeProgram(): Command {
  const program = new Command();
  registerTaskPromptCommands(program);
  return program;
}

/** Captures the outgoing request that the `ky` engine handed to `fetch`. */
interface CapturedRequest {
  url: string;
  method: string;
  body: string;
}

let lastRequest: CapturedRequest | undefined;

function mockFetchWith(body: unknown): void {
  lastRequest = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (req: Request) => {
      // `ky` calls `fetch(request)` with a single `Request`; capture it before the body is consumed.
      lastRequest = { url: req.url, method: req.method, body: await req.text() };
      return { ok: true, status: 200, json: async () => body };
    }),
  );
}

describe("task-prompt list", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("passes --type as a query param", async () => {
    mockFetchWith({ items: [], total: 0 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const program = makeProgram();
      await program.parseAsync(
        ["task-prompt", "list", "--type", "agents.md", "-u", "http://localhost:3100", "--project", "proj-test"],
        { from: "user" },
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(lastRequest?.url).toContain("type=agents.md");
    expect(lastRequest?.url).toContain("projectId=proj-test");
  });

  it("renders blob-backed prompts without crashing on missing text", async () => {
    mockFetchWith({
      items: [{ _id: "abcdef1234", type: "agents.md", contentBlobUrl: "prompts/abcdef1234.txt", createdAt: new Date().toISOString() }],
      total: 1,
    });
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...p: unknown[]) => {
      lines.push(p.map(String).join(" "));
    });

    try {
      const program = makeProgram();
      await program.parseAsync(["task-prompt", "list", "-u", "http://localhost:3100", "--project", "proj-test"], { from: "user" });
    } finally {
      logSpy.mockRestore();
    }

    const output = lines.join("\n");
    expect(output).toContain("agents.md");
    expect(output).toContain("(blob)");
  });
});

describe("task-prompt create", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("sends type in the create body when provided", async () => {
    mockFetchWith({ _id: "id-1", type: "agents.md", createdAt: new Date().toISOString() });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const program = makeProgram();
      await program.parseAsync(
        ["task-prompt", "create", "-t", "# Guidance", "--type", "agents.md", "-u", "http://localhost:3100", "--project", "proj-test"],
        { from: "user" },
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(JSON.parse(lastRequest!.body)).toEqual({ text: "# Guidance", type: "agents.md" });
    expect(lastRequest!.url).toContain("projectId=proj-test");
  });

  it("defaults type to select when not provided", async () => {
    mockFetchWith({ _id: "id-2", createdAt: new Date().toISOString() });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const program = makeProgram();
      await program.parseAsync(
        ["task-prompt", "create", "-t", "plain task", "-u", "http://localhost:3100", "--project", "proj-test"],
        { from: "user" },
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(JSON.parse(lastRequest!.body)).toEqual({ text: "plain task", type: "select" });
    expect(lastRequest!.url).toContain("projectId=proj-test");
  });
});
