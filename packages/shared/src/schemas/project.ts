// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

/**
 * Create a new project. A project is an ordinary, re-nameable container — there
 * is no "default" flag.
 */
export const CreateProjectInputSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    creator: z.string().optional(),
  })
  .openapi("CreateProjectInput");

export const UpdateProjectInputSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
  })
  .openapi("UpdateProjectInput");

export const ProjectResponseSchema = z
  .object({
    _id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    creator: z.string().optional(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    deletedAt: z.coerce.date().optional(),
  })
  .openapi("ProjectResponse");
