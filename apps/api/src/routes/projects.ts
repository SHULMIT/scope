// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import {
  CreateProjectInputSchema,
  UpdateProjectInputSchema,
  ProjectResponseSchema,
} from "shared";
import { apiRoute } from "../openapi/api-route.js";
import type { RouteContext } from "../route-context.js";

/**
 * Projects CRUD.
 *
 * A project is the top-level, **unscoped** container. It has no `projectId`
 * itself. Delete is a **soft-delete**: it is always allowed (even when the
 * project still owns scoped data), because it is fully reversible via
 * `POST /projects/:id/restore`. Soft-deleting a non-empty project simply hides
 * it and its data from the default listings; restoring brings everything back.
 */
export function registerProjectsRoutes(ctx: RouteContext): void {
  // List all projects (newest first). Pass `?includeDeleted=true` to also return
  // soft-deleted projects (so the Portal/CLI can offer a restore affordance).
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/projects",
    tags: ["Projects"],
    summary: "List all projects",
    query: z.object({
      includeDeleted: z
        .enum(["true", "false"])
        .optional()
        .describe("When true, include soft-deleted projects in the result"),
    }),
    response: z.array(ProjectResponseSchema),
    handler: async (req, res, next) => {
      try {
        const includeDeleted = req.query.includeDeleted === "true";
        const projects = await ctx.projectStore.list({ includeDeleted });
        res.json(projects.map((p) => ({ ...p, id: p._id })));
      } catch (error) {
        next(error);
      }
    },
  });

  // Create a project.
  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/projects",
    tags: ["Projects"],
    summary: "Create a project",
    body: CreateProjectInputSchema,
    response: ProjectResponseSchema,
    successStatus: 201,
    errorResponses: { 400: { description: "Invalid input" } },
    handler: async (req, res, next) => {
      try {
        const project = await ctx.projectStore.create(req.body);
        res.status(201).json({ ...project, id: project._id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/name is required/i.test(message)) {
          res.status(400).json({ error: message });
          return;
        }
        next(error);
      }
    },
  });

  // Get a project by id.
  apiRoute(ctx.app, ctx.registry, {
    method: "get",
    path: "/api/v1/projects/:id",
    tags: ["Projects"],
    summary: "Get a project",
    response: ProjectResponseSchema,
    errorResponses: { 404: { description: "Project not found" } },
    handler: async (req, res, next) => {
      try {
        const project = await ctx.projectStore.get(req.params.id);
        if (!project) {
          res.status(404).json({ error: "Project not found" });
          return;
        }
        res.json({ ...project, id: project._id });
      } catch (error) {
        next(error);
      }
    },
  });

  // Patch a project (rename / describe).
  apiRoute(ctx.app, ctx.registry, {
    method: "patch",
    path: "/api/v1/projects/:id",
    tags: ["Projects"],
    summary: "Update a project",
    body: UpdateProjectInputSchema,
    response: ProjectResponseSchema,
    errorResponses: { 404: { description: "Project not found" } },
    handler: async (req, res, next) => {
      try {
        const updated = await ctx.projectStore.update(req.params.id, req.body);
        if (!updated) {
          res.status(404).json({ error: "Project not found" });
          return;
        }
        res.json({ ...updated, id: updated._id });
      } catch (error) {
        next(error);
      }
    },
  });

  // Soft-delete a project. Always allowed (even when non-empty) because it is
  // reversible via POST /projects/:id/restore.
  apiRoute(ctx.app, ctx.registry, {
    method: "delete",
    path: "/api/v1/projects/:id",
    tags: ["Projects"],
    summary: "Soft-delete a project",
    response: z.any(),
    rawResponse: true,
    successStatus: 204,
    errorResponses: {
      404: { description: "Project not found" },
    },
    handler: async (req, res, next) => {
      try {
        const ok = await ctx.projectStore.softDelete(req.params.id);
        if (!ok) {
          res.status(404).json({ error: "Project not found" });
          return;
        }
        res.status(204).send();
      } catch (error) {
        next(error);
      }
    },
  });

  // Restore a soft-deleted project (clears `deletedAt`). Restoring a project
  // that is not deleted is a no-op that returns it unchanged.
  apiRoute(ctx.app, ctx.registry, {
    method: "post",
    path: "/api/v1/projects/:id/restore",
    tags: ["Projects"],
    summary: "Restore a soft-deleted project",
    response: ProjectResponseSchema,
    errorResponses: { 404: { description: "Project not found" } },
    handler: async (req, res, next) => {
      try {
        const existing = await ctx.projectStore.get(req.params.id, { includeDeleted: true });
        if (!existing) {
          res.status(404).json({ error: "Project not found" });
          return;
        }
        // Already active: nothing to restore, return the current document.
        if (!existing.deletedAt) {
          res.json({ ...existing, id: existing._id });
          return;
        }
        const restored = await ctx.projectStore.restore(req.params.id);
        if (!restored) {
          res.status(404).json({ error: "Project not found" });
          return;
        }
        res.json({ ...restored, id: restored._id });
      } catch (error) {
        next(error);
      }
    },
  });
}
