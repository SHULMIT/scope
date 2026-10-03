// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

// Force project resolution to fail so we can assert the command's fail-fast
// behavior regardless of the machine's SCOPE_PROJECT / persisted config.
vi.mock("../utils/config.js", async () => {
  const actual = await vi.importActual<typeof import("../utils/config.js")>("../utils/config.js");
  return {
    ...actual,
    requireProjectId: () => {
      throw new Error("No project selected. Pass --project <id>, set SCOPE_PROJECT, or run `scope project use <id>`.");
    },
  };
});

import { registerRunCommands } from "./run.js";

function makeProgram(): Command {
  const program = new Command();
  registerRunCommands(program);
  return program;
}

describe("run list — fail fast with no project", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("throws and issues no request when no project resolves", async () => {
    // The command layer's fail-fast contract: it must throw *before* doing any
    // I/O, so no request is ever issued. (Rendering that throw as a clean
    // "Error:" + exit(1) is index.ts's top-level handler, not this layer.)
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const program = makeProgram();
    await expect(
      program.parseAsync(["run", "list", "-u", "http://localhost:3100"], { from: "user" }),
    ).rejects.toThrow(/No project selected/);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
