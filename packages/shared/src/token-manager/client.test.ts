// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TokenManagerClient } from "./client.js";

describe("TokenManagerClient", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("acquireToken - env var fallback", () => {
    it("returns GITHUB_TOKEN env var for copilot-sdk capability", async () => {
      process.env.GITHUB_TOKEN = "ghp_test123";
      const client = new TokenManagerClient("http://localhost:3000");

      const result = await client.acquireToken("copilot-sdk");

      expect(result).toBe("ghp_test123");
    });

    it("returns ANTHROPIC_API_KEY env var for claude-code-cli capability", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test456";
      const client = new TokenManagerClient("http://localhost:3000");

      const result = await client.acquireToken("claude-code-cli");

      expect(result).toBe("sk-ant-test456");
    });

    it("returns GITHUB_TOKEN env var for github-models capability", async () => {
      process.env.GITHUB_TOKEN = "ghp_models_789";
      const client = new TokenManagerClient("http://localhost:3000");

      const result = await client.acquireToken("github-models");

      expect(result).toBe("ghp_models_789");
    });
    it("returns GITHUB_TOKEN env var for copilot-cli capability", async () => {
      process.env.GITHUB_TOKEN = "ghp_cli_test";
      const client = new TokenManagerClient("http://localhost:3000");

      const result = await client.acquireToken("copilot-cli");

      expect(result).toBe("ghp_cli_test");
    });

    it("returns GITHUB_TOKEN env var for copilot-models capability", async () => {
      process.env.GITHUB_TOKEN = "ghp_copilot_models_test";
      const client = new TokenManagerClient("http://localhost:3000");

      const result = await client.acquireToken("copilot-models");

      expect(result).toBe("ghp_copilot_models_test");
    });

    it("does not make HTTP call when env var is set", async () => {
      process.env.GITHUB_TOKEN = "ghp_test123";
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const client = new TokenManagerClient("http://localhost:3000");

      await client.acquireToken("copilot-sdk");

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("acquireToken - API call", () => {
    it("calls Token Manager API when env var is not set", async () => {
      delete process.env.GITHUB_TOKEN;
      const mockResponse = {
        ok: true,
        json: async () => ({
          value: "ghp_from_api",
          keyId: "abc-123",
          capability: "copilot-sdk",
        }),
      };
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(mockResponse as Response);

      const client = new TokenManagerClient("http://token-manager:80");
      const result = await client.acquireToken("copilot-sdk");

      expect(result).toBe("ghp_from_api");
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://token-manager:80/api/v1/keys/acquire",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ capability: "copilot-sdk" }),
        })
      );
    });

    it("strips trailing slash from base URL", async () => {
      delete process.env.GITHUB_TOKEN;
      const mockResponse = {
        ok: true,
        json: async () => ({ value: "ghp_test", keyId: "x", capability: "copilot-sdk" }),
      };
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(mockResponse as Response);

      const client = new TokenManagerClient("http://token-manager:80///");
      await client.acquireToken("copilot-sdk");

      expect(fetchSpy).toHaveBeenCalledWith(
        "http://token-manager:80/api/v1/keys/acquire",
        expect.anything()
      );
    });

    it("uses TOKEN_MANAGER_URL env var when no baseUrl provided", async () => {
      delete process.env.GITHUB_TOKEN;
      process.env.TOKEN_MANAGER_URL = "http://tm-from-env:80";
      const mockResponse = {
        ok: true,
        json: async () => ({ value: "ghp_env", keyId: "x", capability: "copilot-sdk" }),
      };
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(mockResponse as Response);

      const client = new TokenManagerClient();
      await client.acquireToken("copilot-sdk");

      expect(fetchSpy).toHaveBeenCalledWith(
        "http://tm-from-env:80/api/v1/keys/acquire",
        expect.anything()
      );
    });
  });

  describe("acquireToken - error handling", () => {
    it("throws when API returns 404 (no tokens available)", async () => {
      delete process.env.GITHUB_TOKEN;
      const mockResponse = {
        ok: false,
        status: 404,
        text: async () => "No valid tokens available for capability 'copilot-sdk'",
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as Response);

      const client = new TokenManagerClient("http://token-manager:80");

      await expect(client.acquireToken("copilot-sdk")).rejects.toThrow(
        /Key acquisition failed.*copilot-sdk.*404/
      );
    });

    it("throws when API returns 500", async () => {
      delete process.env.GITHUB_TOKEN;
      const mockResponse = {
        ok: false,
        status: 500,
        text: async () => "Internal server error",
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as Response);

      const client = new TokenManagerClient("http://token-manager:80");

      await expect(client.acquireToken("copilot-sdk")).rejects.toThrow(
        /Key acquisition failed.*copilot-sdk.*500/
      );
    });

    it("throws when response has no value", async () => {
      delete process.env.GITHUB_TOKEN;
      const mockResponse = {
        ok: true,
        json: async () => ({ keyId: "x", capability: "copilot-sdk" }),
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as Response);

      const client = new TokenManagerClient("http://token-manager:80");

      await expect(client.acquireToken("copilot-sdk")).rejects.toThrow(
        /Invalid key response.*copilot-sdk.*no value/
      );
    });

    it("throws when no env var and no base URL configured", async () => {
      delete process.env.GITHUB_TOKEN;
      delete process.env.TOKEN_MANAGER_URL;

      const client = new TokenManagerClient();

      await expect(client.acquireToken("copilot-sdk")).rejects.toThrow(
        /No key available.*copilot-sdk.*GITHUB_TOKEN.*TOKEN_MANAGER_URL/
      );
    });
  });

  describe("acquireEndpoint", () => {
    beforeEach(() => {
      delete process.env.TOKEN_MANAGER_URL;
      delete process.env.AZURE_AI_INFERENCE_ENDPOINT;
      delete process.env.AZURE_AI_INFERENCE_API_KEY;
      delete process.env.LLM_MODEL;
    });

    it("returns the full env credential without an HTTP call", async () => {
      process.env.AZURE_AI_INFERENCE_ENDPOINT = "https://foundry.example/models";
      process.env.AZURE_AI_INFERENCE_API_KEY = "env-key";
      process.env.LLM_MODEL = "env-model";
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      expect(await new TokenManagerClient().acquireEndpoint("azure-ai-inference")).toEqual({
        endpoint: "https://foundry.example/models",
        apiKey: "env-key",
        deployment: "env-model",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each(["AZURE_AI_INFERENCE_API_KEY", "AZURE_AI_INFERENCE_ENDPOINT"])(
      "acquires from the service when only %s is configured",
      async (name) => {
        process.env[name] = "unpaired-value";
        const credential = { endpoint: "https://foundry.example/models", apiKey: "stored-key", deployment: "stored-model" };
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(credential));

        const result = await new TokenManagerClient("http://token-manager:80/").acquireEndpoint("azure-ai-inference");

        expect(result).toEqual(credential);
        expect(fetchSpy).toHaveBeenCalledWith("http://token-manager:80/api/v1/endpoints/acquire", expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ capability: "azure-ai-inference" }),
          signal: expect.any(AbortSignal),
        }));
      },
    );

    it("accepts a credential without a deployment", async () => {
      const credential = { endpoint: "https://foundry.example/models", apiKey: "stored-key" };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(credential));

      expect(await new TokenManagerClient("http://token-manager:80").acquireEndpoint("azure-ai-inference")).toEqual(credential);
    });

    it.each([404, 500])("reports acquisition HTTP %i errors", async (status) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "unavailable" }, { status }));

      await expect(new TokenManagerClient("http://token-manager:80").acquireEndpoint("azure-ai-inference"))
        .rejects.toThrow(new RegExp(`Endpoint acquisition failed.*azure-ai-inference.*${status}`));
    });

    it.each([
      null,
      {},
      { endpoint: "https://foundry.example/models" },
      { endpoint: 42, apiKey: "key" },
      { endpoint: " ", apiKey: "key" },
      { endpoint: "https://foundry.example/models", apiKey: "" },
      { endpoint: "https://foundry.example/models", apiKey: "key", deployment: 42 },
    ])("rejects malformed endpoint responses: %j", async (body) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));

      await expect(new TokenManagerClient("http://token-manager:80").acquireEndpoint("azure-ai-inference"))
        .rejects.toThrow(/Invalid endpoint response.*azure-ai-inference/);
    });

    it("reports missing endpoint configuration", async () => {
      await expect(new TokenManagerClient().acquireEndpoint("azure-ai-inference"))
        .rejects.toThrow(/No endpoint available.*azure-ai-inference.*TOKEN_MANAGER_URL/);
    });
  });
});
