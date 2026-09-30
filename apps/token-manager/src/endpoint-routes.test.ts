// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Collection, Filter } from "mongodb";
import { TokenManagerClient, type KeyDocument } from "shared";
import { createEndpointRouter } from "./endpoint-routes.js";
import { createKeyRouter } from "./routes.js";
import type { SecretStore } from "./keyvault-store.js";

function key(overrides: Partial<KeyDocument> = {}): KeyDocument {
  return {
    _id: "foundry-1",
    type: "azure-ai-foundry",
    capabilities: ["azure-ai-inference"],
    secretName: "token-azure-ai-foundry-1",
    enabled: true,
    lastValidationStatus: "valid",
    acquireCount: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("endpoint acquisition", () => {
  let docs: KeyDocument[];
  let secrets: Map<string, string>;
  let server: Server;
  let baseUrl: string;
  const updateOne = vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 }));
  const getSecret = vi.fn(async (name: string) => {
    const value = secrets.get(name);
    if (value === undefined) throw new Error("Secret unavailable");
    return value;
  });
  const find = vi.fn((filter: Filter<KeyDocument>) => ({
    toArray: async () => docs.filter((doc) =>
      (!filter.type || doc.type === filter.type) &&
      doc.capabilities.includes("azure-ai-inference") &&
      doc.enabled && doc.lastValidationStatus === "valid" && !doc.deletedAt,
    ),
  }));

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("AZURE_AI_INFERENCE_ENDPOINT", undefined);
    vi.stubEnv("AZURE_AI_INFERENCE_API_KEY", undefined);
    docs = [key()];
    secrets = new Map([[docs[0].secretName, JSON.stringify({
      endpoint: " https://foundry.example/models/// ",
      apiKey: " test-key ",
      model: " deployment-1 ",
      requestProfile: "legacy",
    })]]);
    const collection = { find, updateOne } as unknown as Collection<KeyDocument>;
    const store = { getSecret } as unknown as SecretStore;
    const app = express();
    app.use(express.json());
    app.use(createEndpointRouter(collection, store));
    app.use(createKeyRouter(collection, store));
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  });

  async function acquire(body: unknown = { capability: "azure-ai-inference" }) {
    return fetch(`${baseUrl}/api/v1/endpoints/acquire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns a typed, normalized credential through the real client and HTTP route", async () => {
    expect(await new TokenManagerClient(baseUrl).acquireEndpoint("azure-ai-inference")).toEqual({
      endpoint: "https://foundry.example/models",
      apiKey: "test-key",
      deployment: "deployment-1",
    });
    expect(find).toHaveBeenCalledWith({
      type: "azure-ai-foundry",
      capabilities: { $in: ["azure-ai-inference"] },
      enabled: true,
      lastValidationStatus: "valid",
      deletedAt: { $exists: false },
    });
    expect(updateOne).toHaveBeenCalledWith({ _id: "foundry-1" }, {
      $inc: { acquireCount: 1 }, $set: { lastAcquiredAt: expect.any(Date) },
    });
  });

  it("keeps raw key acquisition backward compatible", async () => {
    const raw = secrets.get(docs[0].secretName);
    expect(await new TokenManagerClient(baseUrl).acquireToken("azure-ai-inference")).toBe(raw);
  });

  it("round-robins across eligible endpoint credentials", async () => {
    docs.push(key({ _id: "foundry-2", secretName: "token-azure-ai-foundry-2" }));
    secrets.set(docs[1].secretName, JSON.stringify({ endpoint: "https://second.example/models", apiKey: "second-key" }));
    const client = new TokenManagerClient(baseUrl);

    expect((await client.acquireEndpoint("azure-ai-inference")).apiKey).toBe("test-key");
    expect(await client.acquireEndpoint("azure-ai-inference")).toEqual({ endpoint: "https://second.example/models", apiKey: "second-key" });
    expect((await client.acquireEndpoint("azure-ai-inference")).apiKey).toBe("test-key");
  });

  it.each([
    { enabled: false },
    { deletedAt: new Date() },
    { lastValidationStatus: "invalid" as const },
    { capabilities: [] },
    { type: "github-oauth" as const },
  ])("excludes ineligible credentials: %j", async (overrides) => {
    docs = [key(overrides)];
    const response = await acquire();
    expect(response.status).toBe(404);
    expect(getSecret).not.toHaveBeenCalled();
    expect(updateOne).not.toHaveBeenCalled();
  });

  it.each([{}, { capability: "github-models" }, { capability: "toString" }, { capability: 42 }, { capability: ["azure-ai-inference"] }])(
    "rejects unsupported capabilities: %j",
    async (body) => {
      expect((await acquire(body)).status).toBe(400);
      expect(find).not.toHaveBeenCalled();
    },
  );

  it.each(["not json", "null", '{"endpoint":"https://foundry.example/models"}'])(
    "rejects malformed stored credentials without exposing their value: %s",
    async (raw) => {
      secrets.set(docs[0].secretName, raw);
      const response = await acquire();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Invalid endpoint credential for key 'foundry-1'" });
      expect(updateOne).not.toHaveBeenCalled();
    },
  );

  it("propagates secret-store failures without counting a successful acquisition", async () => {
    secrets.clear();
    expect((await acquire()).status).toBe(500);
    expect(updateOne).not.toHaveBeenCalled();
  });
});
