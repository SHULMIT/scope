// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerPromptFeatureCommands } from "./prompt-feature.js";

function makeProgram(): Command {
  const program = new Command();
  registerPromptFeatureCommands(program);
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

describe("prompt-feature list", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("passes --type as a query param", async () => {
    mockFetchWith([]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const program = makeProgram();
      await program.parseAsync(
        ["prompt-feature", "list", "--type", "agents.md", "-u", "http://localhost:3100", "--project", "proj-test"],
        { from: "user" },
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(lastRequest?.url).toContain("type=agents.md");
    expect(lastRequest?.url).toContain("projectId=proj-test");
  });

  it("renders a Type column defaulting to 'select'", async () => {
    mockFetchWith([{ id: "feat-1", prompt: "detect something" }]);
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...p: unknown[]) => {
      lines.push(p.map(String).join(" "));
    });

    try {
      const program = makeProgram();
      await program.parseAsync(["prompt-feature", "list", "-u", "http://localhost:3100", "--project", "proj-test"], { from: "user" });
    } finally {
      logSpy.mockRestore();
    }

    expect(lines.join("\n")).toContain("select");
  });
});

describe("prompt-feature create", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("sends type in the create body when provided", async () => {
    mockFetchWith({ id: "feat-new" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const program = makeProgram();
      await program.parseAsync(
        ["prompt-feature", "create", "--id", "my_feat", "--prompt", "detect x", "--type", "agents.md", "-u", "http://localhost:3100", "--project", "proj-test"],
        { from: "user" },
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(JSON.parse(lastRequest!.body)).toEqual({ id: "my_feat", prompt: "detect x", type: "agents.md" });
    expect(lastRequest!.url).toContain("projectId=proj-test");
  });

  it("omits type when not provided (backward compatible)", async () => {
    mockFetchWith({ id: "feat-new-2" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const program = makeProgram();
      await program.parseAsync(
        ["prompt-feature", "create", "--id", "my_feat2", "--prompt", "detect y", "-u", "http://localhost:3100", "--project", "proj-test"],
        { from: "user" },
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(JSON.parse(lastRequest!.body)).toEqual({ id: "my_feat2", prompt: "detect y" });
  });
});
