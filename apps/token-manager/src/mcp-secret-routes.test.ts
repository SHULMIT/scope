// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Collection } from "mongodb";
import type { McpSecretDocument, McpServerDocument } from "shared";
import type { SecretStore } from "./keyvault-store.js";
import { createMcpSecretRouter } from "./mcp-secret-routes.js";

// ─── In-memory fakes ─────────────────────────────────────────────────────────

/**
 * Minimal in-memory secrets collection that honors the { projectId, mcpId, name }
 * scoping the routes rely on. Enough to prove per-project isolation end to end.
 */
function makeSecretsCollection(seed: McpSecretDocument[] = []) {
  const docs = new Map<string, McpSecretDocument>(seed.map((d) => [d._id, { ...d }]));
  const matches = (d: McpSecretDocument, f: any) =>
    (f.projectId === undefined || d.projectId === f.projectId) &&
    (f.mcpId === undefined || d.mcpId === f.mcpId) &&
    (f.name === undefined || d.name === f.name) &&
    (f._id === undefined || d._id === f._id);

  return {
    _docs: docs,
    findOne: async (f: any) => {
      for (const d of docs.values()) if (matches(d, f)) return { ...d };
      return null;
    },
    find: (f: any) => ({
      toArray: async () => [...docs.values()].filter((d) => matches(d, f)).map((d) => ({ ...d })),
    }),
    insertOne: async (doc: McpSecretDocument) => {
      docs.set(doc._id, { ...doc });
      return { insertedId: doc._id };
    },
    updateOne: async (f: any, update: any) => {
      for (const d of docs.values()) {
        if (matches(d, f)) {
          Object.assign(d, update.$set ?? {});
          return { matchedCount: 1, modifiedCount: 1 };
        }
      }
      return { matchedCount: 0, modifiedCount: 0 };
    },
    deleteOne: async (f: any) => {
      for (const [k, d] of docs.entries()) {
        if (matches(d, f)) {
          docs.delete(k);
          return { deletedCount: 1 };
        }
      }
      return { deletedCount: 0 };
    },
  } as unknown as Collection<McpSecretDocument> & { _docs: Map<string, McpSecretDocument> };
}

function makeServerCollection(servers: McpServerDocument[]) {
  const matchesOr = (d: McpServerDocument, f: any) => {
    if (f.projectId !== undefined && d.projectId !== f.projectId) return false;
    if (f.deletedAt?.$exists === false && (d as any).deletedAt) return false;
    if (f.$or) return f.$or.some((c: any) => (c.slug && d.slug === c.slug) || (c._id && d._id === c._id));
    return true;
  };
  return {
    findOne: async (f: any) => {
      for (const d of servers) if (matchesOr(d, f)) return { ...d };
      return null;
    },
  } as unknown as Collection<McpServerDocument>;
}

/** In-memory KV store keyed by KV secret name. */
function makeStore() {
  const kv = new Map<string, string>();
  return {
    setSecret: async (name: string, value: string) => void kv.set(name, value),
    getSecret: async (name: string) => kv.get(name) ?? "",
    deleteSecret: async (name: string) => void kv.delete(name),
    _kv: kv,
  } as unknown as SecretStore & { _kv: Map<string, string> };
}

// ─── Live server harness ─────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

function listen(
  secrets: Collection<McpSecretDocument>,
  serversCol: Collection<McpServerDocument>,
  store: SecretStore,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(createMcpSecretRouter(secrets, serversCol, store));
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("mcp-secret-routes — project-scoped secrets", () => {
  it("400s every route when ?projectId= is missing", async () => {
    await listen(makeSecretsCollection(), makeServerCollection([]), makeStore());

    const post = await fetch(`${baseUrl}/api/v1/mcp/servers/srv/secrets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "K", value: "v" }),
    });
    const list = await fetch(`${baseUrl}/api/v1/mcp/servers/srv/secrets`);
    expect(post.status).toBe(400);
    expect(list.status).toBe(400);
    expect((await post.json()).error).toMatch(/projectId/);
  });

  it("stores and lists a secret scoped to its project", async () => {
    const secrets = makeSecretsCollection();
    await listen(secrets, makeServerCollection([]), makeStore());

    const created = await fetch(`${baseUrl}/api/v1/mcp/servers/ms-learn/secrets?projectId=proj-a`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "API_KEY", value: "a-secret" }),
    });
    expect(created.status).toBe(201);

    const doc = [...(secrets as any)._docs.values()][0];
    expect(doc.projectId).toBe("proj-a");
    expect(doc.mcpId).toBe("ms-learn");

    const listed = await (await fetch(`${baseUrl}/api/v1/mcp/servers/ms-learn/secrets?projectId=proj-a`)).json();
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("API_KEY");
  });

  it("isolates identical mcpId+name secrets across projects", async () => {
    const secrets = makeSecretsCollection();
    const store = makeStore();
    // Same slug 'ms-learn' registered (and resolvable) in both projects.
    const servers = makeServerCollection([
      { _id: "u-a", slug: "ms-learn", projectId: "proj-a", name: "L", type: "http", url: "https://a", createdAt: new Date() } as any,
      { _id: "u-b", slug: "ms-learn", projectId: "proj-b", name: "L", type: "http", url: "https://b", createdAt: new Date() } as any,
    ]);
    await listen(secrets, servers, store);

    // Same mcpId + same secret name, different projects and values.
    for (const [projectId, value] of [["proj-a", "value-A"], ["proj-b", "value-B"]] as const) {
      const r = await fetch(`${baseUrl}/api/v1/mcp/servers/ms-learn/secrets?projectId=${projectId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "TOKEN", value }),
      });
      expect(r.status).toBe(201);
    }

    // Two distinct secret docs — no collision on the shared (mcpId, name).
    expect((secrets as any)._docs.size).toBe(2);

    // resolve returns each project's own value, never the other's.
    const resolvedA = await (await fetch(`${baseUrl}/api/v1/mcp/servers/ms-learn/secrets/resolve?projectId=proj-a`)).json();
    const resolvedB = await (await fetch(`${baseUrl}/api/v1/mcp/servers/ms-learn/secrets/resolve?projectId=proj-b`)).json();
    expect(resolvedA.headers).toEqual([{ name: "TOKEN", value: "value-A" }]);
    expect(resolvedB.headers).toEqual([{ name: "TOKEN", value: "value-B" }]);
  });

  it("resolve 404s when the slug exists only in another project", async () => {
    const servers = makeServerCollection([
      { _id: "u-a", slug: "ms-learn", projectId: "proj-a", name: "L", type: "http", url: "https://a", createdAt: new Date() } as any,
    ]);
    await listen(makeSecretsCollection(), servers, makeStore());

    const hit = await fetch(`${baseUrl}/api/v1/mcp/servers/ms-learn/secrets/resolve?projectId=proj-a`);
    const miss = await fetch(`${baseUrl}/api/v1/mcp/servers/ms-learn/secrets/resolve?projectId=proj-b`);
    expect(hit.status).toBe(200);
    expect(miss.status).toBe(404);
  });

  it("deletes a secret only within its own project", async () => {
    const secrets = makeSecretsCollection([
      { _id: "s-a", projectId: "proj-a", mcpId: "ms-learn", name: "TOKEN", createdAt: new Date(), updatedAt: new Date() },
      { _id: "s-b", projectId: "proj-b", mcpId: "ms-learn", name: "TOKEN", createdAt: new Date(), updatedAt: new Date() },
    ]);
    await listen(secrets, makeServerCollection([]), makeStore());

    const del = await fetch(`${baseUrl}/api/v1/mcp/servers/ms-learn/secrets/TOKEN?projectId=proj-a`, { method: "DELETE" });
    expect(del.status).toBe(204);
    // proj-b's identically-named secret is untouched.
    expect((secrets as any)._docs.has("s-b")).toBe(true);
    expect((secrets as any)._docs.has("s-a")).toBe(false);
  });
});
