// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpSecretClient, McpSecretUnavailableError } from "./mcp-secret-client.js";
import type { McpSecretListItem } from "./mcp-secret-client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const BASE_URL = "https://token-manager.dev";
const PROJECT_ID = "proj-test";

function makeSecretItem(overrides: Partial<McpSecretListItem> = {}): McpSecretListItem {
  return {
    id: "abc123",
    mcpId: "test-server",
    name: "MY_SECRET",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : status === 404 ? "Not Found" : "Error",
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as Response;
}

describe("McpSecretClient", () => {
  let client: McpSecretClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new McpSecretClient(BASE_URL);
  });

  it("strips trailing slashes from the Token Manager URL and scopes by projectId", async () => {
    const c = new McpSecretClient(`${BASE_URL}///`);
    mockFetch.mockResolvedValueOnce(jsonResponse(makeSecretItem()));

    await c.storeSecret(PROJECT_ID, "srv", "KEY", "val");

    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/v1/mcp/servers/srv/secrets?projectId=proj-test`,
      expect.objectContaining({ method: "POST" })
    );
  });

  describe("storeSecret()", () => {
    it("sends POST with name and value, scoped by projectId", async () => {
      const item = makeSecretItem({ mcpId: "my-srv", name: "API_KEY" });
      mockFetch.mockResolvedValueOnce(jsonResponse(item));

      const result = await client.storeSecret(PROJECT_ID, "my-srv", "API_KEY", "secret-value");

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/mcp/servers/my-srv/secrets?projectId=proj-test`,
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "API_KEY", value: "secret-value" }),
        })
      );
      expect(result).toEqual(item);
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));

      await expect(client.storeSecret(PROJECT_ID, "srv", "KEY", "val")).rejects.toThrow(
        /POST .* failed: 500/
      );
    });

    it("URL-encodes the mcpId", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(makeSecretItem()));

      await client.storeSecret(PROJECT_ID, "my/server", "KEY", "val");

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/mcp/servers/my%2Fserver/secrets?projectId=proj-test`,
        expect.any(Object)
      );
    });
  });

  describe("storeEnv()", () => {
    it("stores each env pair sequentially", async () => {
      const item1 = makeSecretItem({ name: "A" });
      const item2 = makeSecretItem({ name: "B" });
      mockFetch
        .mockResolvedValueOnce(jsonResponse(item1))
        .mockResolvedValueOnce(jsonResponse(item2));

      const results = await client.storeEnv(PROJECT_ID, "srv", { A: "1", B: "2" });

      expect(results).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("storeHeaders()", () => {
    it("stores each header sequentially", async () => {
      const item1 = makeSecretItem({ name: "Authorization" });
      const item2 = makeSecretItem({ name: "X-Custom" });
      mockFetch
        .mockResolvedValueOnce(jsonResponse(item1))
        .mockResolvedValueOnce(jsonResponse(item2));

      const results = await client.storeHeaders(PROJECT_ID, "srv", [
        { name: "Authorization", value: "******" },
        { name: "X-Custom", value: "val" },
      ]);

      expect(results).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("listSecrets()", () => {
    it("returns secret metadata array, scoped by projectId", async () => {
      const items = [makeSecretItem({ name: "A" }), makeSecretItem({ name: "B" })];
      mockFetch.mockResolvedValueOnce(jsonResponse(items));

      const result = await client.listSecrets(PROJECT_ID, "my-srv");

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/mcp/servers/my-srv/secrets?projectId=proj-test`,
        undefined
      );
      expect(result).toEqual(items);
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));

      await expect(client.listSecrets(PROJECT_ID, "srv")).rejects.toThrow(/GET .* failed: 500/);
    });
  });

  describe("resolveSecrets()", () => {
    it("returns env map for stdio servers, scoped by projectId", async () => {
      const resolved = { env: { API_KEY: "secret" } };
      mockFetch.mockResolvedValueOnce(jsonResponse(resolved));

      const result = await client.resolveSecrets(PROJECT_ID, "my-srv");

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/mcp/servers/my-srv/secrets/resolve?projectId=proj-test`,
        undefined
      );
      expect(result).toEqual(resolved);
    });

    it("returns headers array for http servers", async () => {
      const resolved = { headers: [{ name: "Authorization", value: "******" }] };
      mockFetch.mockResolvedValueOnce(jsonResponse(resolved));

      const result = await client.resolveSecrets(PROJECT_ID, "my-srv");
      expect(result).toEqual(resolved);
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 403));

      await expect(client.resolveSecrets(PROJECT_ID, "srv")).rejects.toThrow(/GET .* failed: 403/);
    });
  });

  describe("deleteSecret()", () => {
    it("sends DELETE to the correct URL, scoped by projectId", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));

      await client.deleteSecret(PROJECT_ID, "my-srv", "API_KEY");

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/mcp/servers/my-srv/secrets/API_KEY?projectId=proj-test`,
        expect.objectContaining({ method: "DELETE" })
      );
    });

    it("treats 404 as success (idempotent)", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 404));

      await expect(client.deleteSecret(PROJECT_ID, "srv", "MISSING")).resolves.toBeUndefined();
    });

    it("throws on non-404 error", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));

      await expect(client.deleteSecret(PROJECT_ID, "srv", "KEY")).rejects.toThrow(
        /DELETE .* failed: 500/
      );
    });

    it("URL-encodes the secret name", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));

      await client.deleteSecret(PROJECT_ID, "srv", "my/key");

      expect(mockFetch).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/mcp/servers/srv/secrets/my%2Fkey?projectId=proj-test`,
        expect.any(Object)
      );
    });
  });

  describe("deleteAllSecrets()", () => {
    it("lists then deletes each secret", async () => {
      const items = [makeSecretItem({ name: "A" }), makeSecretItem({ name: "B" })];
      mockFetch
        .mockResolvedValueOnce(jsonResponse(items))    // listSecrets
        .mockResolvedValueOnce(jsonResponse({}, 200))  // delete A
        .mockResolvedValueOnce(jsonResponse({}, 200)); // delete B

      await client.deleteAllSecrets(PROJECT_ID, "srv");

      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("swallows list error gracefully", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network"));

      // deleteAllSecrets catches the list error and returns empty
      // But fetchOrThrow wraps network errors as McpSecretUnavailableError
      // and listSecrets.catch() swallows it — so no deletions happen
      await expect(client.deleteAllSecrets(PROJECT_ID, "srv")).resolves.toBeUndefined();
    });
  });

  describe("McpSecretUnavailableError", () => {
    it("wraps network errors with descriptive message", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

      await expect(client.listSecrets(PROJECT_ID, "srv")).rejects.toThrow(McpSecretUnavailableError);

      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

      await expect(client.listSecrets(PROJECT_ID, "srv")).rejects.toThrow(/Token Manager is unreachable/);
    });

    it("wraps non-Error causes", async () => {
      mockFetch.mockRejectedValueOnce("string error");

      await expect(client.storeSecret(PROJECT_ID, "srv", "KEY", "val")).rejects.toThrow(
        /Token Manager is unreachable.*string error/
      );
    });
  });
});
