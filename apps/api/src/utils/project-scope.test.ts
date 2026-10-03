// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import type { Request } from "express";
import type { Collection } from "mongodb";
import {
  ProjectScopeError,
  ProjectIdQuerySchema,
  getQueryProjectId,
  getOptionalQueryProjectId,
  deriveProjectIdFromParent,
  assertSameProject,
} from "./project-scope.js";

/** Build a minimal Express-like request carrying only a query bag. */
function reqWithQuery(query: Record<string, unknown>): Request {
  return { query } as unknown as Request;
}

/** Minimal `findOne`-only collection stub for derive tests. */
function parentCollection<TDoc extends { _id: string; projectId?: string }>(
  docs: TDoc[],
): Collection<TDoc> {
  return {
    async findOne(filter: { _id: string }) {
      return docs.find((d) => d._id === filter._id) ?? null;
    },
  } as unknown as Collection<TDoc>;
}

describe("ProjectScopeError", () => {
  it("defaults to a 400 status", () => {
    const err = new ProjectScopeError("nope");
    expect(err.status).toBe(400);
    expect(err.name).toBe("ProjectScopeError");
    expect(err).toBeInstanceOf(Error);
  });

  it("carries a custom status (404/409)", () => {
    expect(new ProjectScopeError("missing", 404).status).toBe(404);
    expect(new ProjectScopeError("cross", 409).status).toBe(409);
  });
});

describe("ProjectIdQuerySchema", () => {
  it("accepts a non-empty projectId", () => {
    const parsed = ProjectIdQuerySchema.parse({ projectId: "proj-1" });
    expect(parsed.projectId).toBe("proj-1");
  });

  it("rejects a missing or empty projectId (min length 1)", () => {
    expect(ProjectIdQuerySchema.safeParse({}).success).toBe(false);
    expect(ProjectIdQuerySchema.safeParse({ projectId: "" }).success).toBe(false);
  });
});

describe("getQueryProjectId", () => {
  it("returns the trimmed projectId", () => {
    expect(getQueryProjectId(reqWithQuery({ projectId: "  proj-1  " }))).toBe("proj-1");
  });

  it("throws a 400 ProjectScopeError when absent", () => {
    try {
      getQueryProjectId(reqWithQuery({}));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectScopeError);
      expect((err as ProjectScopeError).status).toBe(400);
    }
  });

  it("throws when blank or whitespace-only", () => {
    expect(() => getQueryProjectId(reqWithQuery({ projectId: "   " }))).toThrow(ProjectScopeError);
    expect(() => getQueryProjectId(reqWithQuery({ projectId: "" }))).toThrow(ProjectScopeError);
  });

  it("throws when the value is not a string", () => {
    expect(() => getQueryProjectId(reqWithQuery({ projectId: 123 }))).toThrow(ProjectScopeError);
    expect(() => getQueryProjectId(reqWithQuery({ projectId: ["a", "b"] }))).toThrow(ProjectScopeError);
  });
});

describe("getOptionalQueryProjectId", () => {
  it("returns the trimmed projectId when present", () => {
    expect(getOptionalQueryProjectId(reqWithQuery({ projectId: " proj-2 " }))).toBe("proj-2");
  });

  it("returns undefined when absent, blank, or non-string", () => {
    expect(getOptionalQueryProjectId(reqWithQuery({}))).toBeUndefined();
    expect(getOptionalQueryProjectId(reqWithQuery({ projectId: "   " }))).toBeUndefined();
    expect(getOptionalQueryProjectId(reqWithQuery({ projectId: 42 }))).toBeUndefined();
  });
});

describe("deriveProjectIdFromParent", () => {
  it("returns the parent's projectId", async () => {
    const col = parentCollection([{ _id: "run-1", projectId: "proj-1" }]);
    await expect(deriveProjectIdFromParent(col, "run-1")).resolves.toBe("proj-1");
  });

  it("throws 404 when the parent is missing", async () => {
    const col = parentCollection<{ _id: string; projectId?: string }>([]);
    await expect(
      deriveProjectIdFromParent(col, "missing", { parentLabel: "run" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("throws 400 when the parent carries no projectId", async () => {
    const col = parentCollection([{ _id: "run-2" }]);
    await expect(deriveProjectIdFromParent(col, "run-2")).rejects.toMatchObject({ status: 400 });
  });

  it("uses the custom parent label in the error message", async () => {
    const col = parentCollection<{ _id: string; projectId?: string }>([]);
    await expect(
      deriveProjectIdFromParent(col, "p9", { parentLabel: "profile" }),
    ).rejects.toThrow(/profile 'p9' not found/);
  });
});

describe("assertSameProject", () => {
  it("does not throw when the projects match", () => {
    expect(() => assertSameProject("proj-1", "proj-1", "codebase")).not.toThrow();
  });

  it("throws a 409 on a cross-project reference", () => {
    try {
      assertSameProject("proj-1", "proj-2", "codebase");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectScopeError);
      expect((err as ProjectScopeError).status).toBe(409);
      expect((err as Error).message).toMatch(/Cross-project reference rejected/);
    }
  });
});
