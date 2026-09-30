// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const modelClient = vi.hoisted(() => vi.fn(() => ({ path: vi.fn() })));
vi.mock("@azure-rest/ai-inference", () => ({ default: modelClient }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const name of [
    "TOKEN_MANAGER_URL",
    "AZURE_AI_INFERENCE_ENDPOINT",
    "AZURE_AI_INFERENCE_API_KEY",
    "GITHUB_MODELS_API_KEY",
    "GITHUB_TOKEN",
    "LLM_MODEL",
  ]) {
    vi.stubEnv(name, undefined);
  }
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("acquireInferenceClient", () => {
  it("uses a structured Token Manager endpoint and its deployment", async () => {
    vi.stubEnv("TOKEN_MANAGER_URL", "http://token-manager:3000");
    vi.stubEnv("LLM_MODEL", "default-model");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ endpoint: "https://foundry.example/models", apiKey: "test-key", deployment: "registered-model" }),
    );
    const { acquireInferenceClient } = await import("./llm-token.js");

    const handle = await acquireInferenceClient();

    expect(handle).toMatchObject({
      endpoint: "https://foundry.example/models",
      model: "registered-model",
      source: "azure-ai-foundry",
      via: "azure-ai-foundry-token-manager",
    });
    expect(modelClient).toHaveBeenCalledWith("https://foundry.example/models", expect.objectContaining({ key: "test-key" }));
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith("http://token-manager:3000/api/v1/endpoints/acquire", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ capability: "azure-ai-inference" }),
    }));
  });

  it("does not let a lone Foundry API key hide a registered endpoint", async () => {
    vi.stubEnv("TOKEN_MANAGER_URL", "http://token-manager:3000");
    vi.stubEnv("AZURE_AI_INFERENCE_API_KEY", "unpaired-env-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ endpoint: "https://foundry.example/models", apiKey: "registered-key" }),
    );
    const { acquireInferenceClient } = await import("./llm-token.js");

    expect(await acquireInferenceClient()).toMatchObject({ source: "azure-ai-foundry", model: "gpt-4.1" });
    expect(modelClient).toHaveBeenCalledWith("https://foundry.example/models", expect.objectContaining({ key: "registered-key" }));
  });

  it("prefers complete Foundry env credentials without contacting the Token Manager", async () => {
    vi.stubEnv("TOKEN_MANAGER_URL", "http://token-manager:3000");
    vi.stubEnv("AZURE_AI_INFERENCE_ENDPOINT", "https://local.services.ai.azure.com/");
    vi.stubEnv("AZURE_AI_INFERENCE_API_KEY", "env-key");
    vi.stubEnv("LLM_MODEL", "env-model");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { acquireInferenceClient } = await import("./llm-token.js");

    expect(await acquireInferenceClient()).toMatchObject({
      endpoint: "https://local.services.ai.azure.com/models",
      model: "env-model",
      via: "azure-ai-foundry-env",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([404, 500])("preserves GitHub Models fallback when endpoint acquisition returns %i", async (status) => {
    vi.stubEnv("TOKEN_MANAGER_URL", "http://token-manager:3000");
    vi.stubEnv("GITHUB_MODELS_API_KEY", "github-key");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "unavailable" }, { status }));
    const { acquireInferenceClient } = await import("./llm-token.js");

    expect(await acquireInferenceClient()).toMatchObject({ source: "github-models", via: "github-models-env" });
  });

  it("reports an actionable error when no inference credential is available", async () => {
    const { acquireInferenceClient } = await import("./llm-token.js");
    await expect(acquireInferenceClient()).rejects.toThrow("LLM not configured");
  });
});
