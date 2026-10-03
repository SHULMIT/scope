// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { PromptTypeSchema } from "./prompt-type.js";

extendZodWithOpenApi(z);

export const CreatePromptFeatureInputSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    prompt: z.string(),
    type: PromptTypeSchema.optional(),
  })
  .openapi("CreatePromptFeatureInput");

export const UpdatePromptFeatureInputSchema = z
  .object({
    prompt: z.string().optional(),
  })
  .openapi("UpdatePromptFeatureInput");

export const PromptFeatureResponseSchema = z
  .object({
    id: z.string(),
    prompt: z.string(),
    type: PromptTypeSchema.optional(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    deletedAt: z.coerce.date().optional(),
    projectId: z.string(),
  })
  .openapi("PromptFeatureResponse");

export const PromptFeatureResultSchema = z
  .object({
    featureId: z.string(),
    detected: z.boolean(),
    evaluated: z.boolean(),
  })
  .openapi("PromptFeatureResult");

export const SuggestedPromptFeatureSchema = z
  .object({
    suggestedId: z.string(),
    behavior: z.string(),
    prompt: z.string(),
  })
  .openapi("SuggestedPromptFeature");
