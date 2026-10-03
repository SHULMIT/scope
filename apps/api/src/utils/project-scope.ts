// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import type { Collection } from "mongodb";
import type { Request } from "express";

extendZodWithOpenApi(z);

/**
 * Thrown when a scoped operation cannot resolve its project.
 *
 * There is **no default project** — an unresolvable scope is always a client
 * error, never a silent fallback:
 *  - missing/blank `?projectId=` on a scoped list or root create → **400**
 *  - a referenced parent that does not exist                     → **404**
 *  - a cross-project reference (parents in different projects)   → **409**
 *
 * The global error handler in `index.ts` maps this to `err.status`.
 */
export class ProjectScopeError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "ProjectScopeError";
  }
}

/**
 * Reusable query-schema fragment that makes `?projectId=` a **required** query
 * parameter. Merge/spread it into a scoped route's `query` schema so `apiRoute`
 * validates it (returning 400 automatically when absent) and documents it in
 * the generated OpenAPI spec.
 */
export const ProjectIdQuerySchema = z.object({
  projectId: z
    .string()
    .min(1)
    .openapi({
      param: { name: "projectId", in: "query", required: true },
      description:
        "Project scope. Required on scoped list and root-create operations; " +
        "requests without a resolvable project are rejected with 400. There is " +
        "no default project.",
      example: "00000000-0000-0000-0000-000000000000",
    }),
});

/**
 * Optional variant of {@link ProjectIdQuerySchema}: documents `?projectId=` as an
 * **optional** query parameter. Merge/spread it into point-read routes (get/delete
 * by human slug) so the client can pass a project scope to disambiguate slugs that
 * repeat across projects, while legacy callers that omit it still resolve globally.
 */
export const OptionalProjectIdQuerySchema = z.object({
  projectId: z
    .string()
    .min(1)
    .optional()
    .openapi({
      param: { name: "projectId", in: "query", required: false },
      description:
        "Optional project scope. When provided, a slug/id is resolved within that " +
        "project (slugs may repeat across projects); when omitted, resolution falls " +
        "back to a legacy global lookup for backward compatibility.",
      example: "00000000-0000-0000-0000-000000000000",
    }),
});

/**
 * Read the (schema-validated) `?projectId=` from a scoped request.
 *
 * Routes that spread {@link ProjectIdQuerySchema} into their `query` schema
 * already 400 before the handler runs; this reader is the single accessor and
 * throws {@link ProjectScopeError} as defense in depth for callers that forgot
 * to require the param.
 */
export function getQueryProjectId(req: Request): string {
  const raw = (req.query as { projectId?: unknown }).projectId;
  const projectId = typeof raw === "string" ? raw.trim() : "";
  if (!projectId) {
    throw new ProjectScopeError(
      "A 'projectId' query parameter is required for this scoped operation.",
    );
  }
  return projectId;
}

/**
 * Optional variant of {@link getQueryProjectId}: returns the trimmed
 * `?projectId=` when present, or `undefined` when absent. Use for endpoints
 * where a project may be derived from a parent instead (e.g. insights created
 * by an agent from a report vs. created by a user from scratch).
 */
export function getOptionalQueryProjectId(req: Request): string | undefined {
  const raw = (req.query as { projectId?: unknown }).projectId;
  const projectId = typeof raw === "string" ? raw.trim() : "";
  return projectId || undefined;
}

/**
 * Derive a child entity's project from its parent. Loads the parent by `_id`
 * and returns its `projectId`. Throws {@link ProjectScopeError} (404 when the
 * parent is missing, 400 when it carries no project).
 */
export async function deriveProjectIdFromParent<
  TDoc extends { _id: string; projectId?: string },
>(
  collection: Collection<TDoc>,
  parentId: string,
  opts?: { parentLabel?: string },
): Promise<string> {
  const label = opts?.parentLabel ?? "parent";
  const parent = await collection.findOne({ _id: parentId } as never);
  if (!parent) {
    throw new ProjectScopeError(
      `Cannot resolve project: ${label} '${parentId}' not found.`,
      404,
    );
  }
  if (!parent.projectId) {
    throw new ProjectScopeError(
      `Cannot resolve project: ${label} '${parentId}' has no projectId.`,
    );
  }
  return parent.projectId;
}

/**
 * Assert that a referenced parent resolves to the same project as the one being
 * written. Rejects cross-project references with a 409 conflict.
 */
export function assertSameProject(
  expected: string,
  actual: string,
  label: string,
): void {
  if (expected !== actual) {
    throw new ProjectScopeError(
      `Cross-project reference rejected: ${label} belongs to project ` +
        `'${actual}', expected '${expected}'.`,
      409,
    );
  }
}
