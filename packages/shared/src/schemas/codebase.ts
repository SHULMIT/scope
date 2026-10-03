// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const CodebaseSourceTypeSchema = z.enum(["git", "archive"]);

/**
 * Create a new codebase entity. Git codebases require `source` ("owner/repo").
 * Archive codebases are created atomically with their first revision: the create
 * request must include the archive file (multipart), and the codebase is rolled
 * back if the archive is missing or invalid.
 */
export const CreateCodebaseInputSchema = z
  .object({
    name: z.string().min(1),
    slug: z.string().min(1).optional(),
    description: z.string().optional(),
    sourceType: CodebaseSourceTypeSchema,
    source: z.string().optional(),
    defaultBranch: z.string().optional(),
    creator: z.string().optional(),
  })
  .openapi("CreateCodebaseInput");

export const UpdateCodebaseInputSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    defaultBranch: z.string().optional(),
  })
  .openapi("UpdateCodebaseInput");

/**
 * Resolve a new git revision: snapshot the repo at the given ref
 * (branch/tag/sha or "latest"). Always creates a new incremental revision.
 */
export const ResolveCodebaseRevisionInputSchema = z
  .object({
    requestedRef: z.string().optional(),
    creator: z.string().optional(),
  })
  .openapi("ResolveCodebaseRevisionInput");

export const CodebaseResponseSchema = z
  .object({
    _id: z.string(),
    slug: z.string(),
    name: z.string(),
    description: z.string().optional(),
    sourceType: CodebaseSourceTypeSchema,
    source: z.string().optional(),
    defaultBranch: z.string().optional(),
    revisionCounter: z.number(),
    latestRevisionId: z.string().optional(),
    creator: z.string().optional(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    deletedAt: z.coerce.date().optional(),
    projectId: z.string(),
  })
  .openapi("CodebaseResponse");

export const CodebaseRevisionResponseSchema = z
  .object({
    _id: z.string(),
    codebaseId: z.string(),
    slug: z.string(),
    revisionNumber: z.number(),
    ref: z.string(),
    sourceType: CodebaseSourceTypeSchema,
    source: z.string().optional(),
    requestedRef: z.string().optional(),
    resolvedCommitSha: z.string().optional(),
    commitTimestamp: z.coerce.date().optional(),
    originalFilename: z.string().optional(),
    contentSha256: z.string().optional(),
    archiveUrl: z.string(),
    sizeBytes: z.number().optional(),
    fileCount: z.number().optional(),
    creator: z.string().optional(),
    resolvedAt: z.coerce.date(),
    createdAt: z.coerce.date(),
    /**
     * True when this revision was reused (deduplicated) because the resolved
     * commit/content was unchanged, rather than newly created. Only set on
     * resolve/upload responses; absent when listing/fetching revisions.
     */
    deduplicated: z.boolean().optional(),
    projectId: z.string(),
  })
  .openapi("CodebaseRevisionResponse");
