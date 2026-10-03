// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Router } from "express";
import { Collection, ObjectId } from "mongodb";
import type { McpSecretDocument, McpServerDocument } from "shared";
import { SecretStore } from "./keyvault-store.js";

/** KV secret name for an MCP secret — keyed by its MongoDB _id to prevent collisions on rename */
function secretKvName(id: string): string {
  return `mcp-secret-${id}`;
}

/**
 * Read the required `projectId` query parameter. Secrets are scoped per project
 * ({ projectId, mcpId=slug, name }), so every route requires it. Responds 400 and
 * returns null when absent — the API client always supplies it.
 */
function getProjectId(req: { query: Record<string, unknown> }, res: { status: (n: number) => { json: (b: unknown) => void } }): string | null {
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  if (!projectId) {
    res.status(400).json({ error: "projectId query parameter is required" });
    return null;
  }
  return projectId;
}

export function createMcpSecretRouter(
  secretsCollection: Collection<McpSecretDocument>,
  mcpServerCollection: Collection<McpServerDocument>,
  store: SecretStore,
): Router {
  const router = Router();

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/v1/mcp/servers/:id/secrets — upsert a secret by name
  // ──────────────────────────────────────────────────────────────────────────
  router.post("/api/v1/mcp/servers/:id/secrets", async (req, res, next) => {
    try {
      const projectId = getProjectId(req, res);
      if (!projectId) return;
      const mcpId = req.params.id;
      const { name, value } = req.body as { name?: string; value?: string };

      if (!name || typeof name !== "string") {
        res.status(400).json({ error: "name is required" });
        return;
      }
      if (!value || typeof value !== "string") {
        res.status(400).json({ error: "value is required" });
        return;
      }

      const existing = await secretsCollection.findOne({ projectId, mcpId, name });
      const now = new Date();

      if (existing) {
        // Overwrite KV secret in-place, update updatedAt
        await store.setSecret(secretKvName(existing._id), value);
        await secretsCollection.updateOne({ _id: existing._id as any }, { $set: { updatedAt: now } });
        res.json({ id: existing._id, mcpId: existing.mcpId, name: existing.name, createdAt: existing.createdAt, updatedAt: now });
      } else {
        // New secret — write to KV first, then MongoDB (rollback KV on failure)
        const newId = new ObjectId().toHexString();
        const kvName = secretKvName(newId);
        await store.setSecret(kvName, value);
        const doc: McpSecretDocument = { _id: newId, projectId, mcpId, name, createdAt: now, updatedAt: now };
        try {
          await secretsCollection.insertOne(doc as any);
        } catch (err) {
          await store.deleteSecret(kvName).catch(() => {});
          throw err;
        }
        res.status(201).json({ id: doc._id, mcpId: doc.mcpId, name: doc.name, createdAt: doc.createdAt, updatedAt: doc.updatedAt });
      }
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/v1/mcp/servers/:id/secrets — list metadata (no values)
  // ──────────────────────────────────────────────────────────────────────────
  router.get("/api/v1/mcp/servers/:id/secrets", async (req, res, next) => {
    try {
      const projectId = getProjectId(req, res);
      if (!projectId) return;
      const mcpId = req.params.id;
      const docs = await secretsCollection.find({ projectId, mcpId }).toArray();
      res.json(docs.map((d) => ({
        id: d._id,
        mcpId: d.mcpId,
        name: d.name,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      })));
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/v1/mcp/servers/:id/secrets/resolve — return plaintext values
  // Transport-aware: env map for stdio, headers array for sse/http
  // Internal use only — called by API before registering with MCP gateway
  // ──────────────────────────────────────────────────────────────────────────
  router.get("/api/v1/mcp/servers/:id/secrets/resolve", async (req, res, next) => {
    try {
      const projectId = getProjectId(req, res);
      if (!projectId) return;
      const mcpId = req.params.id;

      // Server slug is reused across projects, so resolve within the project.
      // `slug` is the post-027 reference key; fall back to `_id` for pre-migration rows.
      const server = await mcpServerCollection.findOne({
        projectId,
        $or: [{ slug: mcpId }, { _id: mcpId }],
        deletedAt: { $exists: false },
      });
      if (!server) {
        res.status(404).json({ error: "MCP server not found" });
        return;
      }

      const docs = await secretsCollection.find({ projectId, mcpId }).toArray();

      if (server.type === "stdio") {
        const env: Record<string, string> = {};
        for (const doc of docs) {
          env[doc.name] = await store.getSecret(secretKvName(doc._id));
        }
        res.json({ env });
      } else {
        // sse / http — return as headers array
        const headers: Array<{ name: string; value: string }> = [];
        for (const doc of docs) {
          headers.push({ name: doc.name, value: await store.getSecret(secretKvName(doc._id)) });
        }
        res.json({ headers });
      }
    } catch (err) {
      next(err);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // DELETE /api/v1/mcp/servers/:id/secrets/:name — delete one secret by name
  // ──────────────────────────────────────────────────────────────────────────
  router.delete("/api/v1/mcp/servers/:id/secrets/:name", async (req, res, next) => {
    try {
      const projectId = getProjectId(req, res);
      if (!projectId) return;
      const { id: mcpId, name } = req.params;

      const doc = await secretsCollection.findOne({ projectId, mcpId, name });
      if (!doc) {
        res.status(404).json({ error: "Secret not found" });
        return;
      }

      // Best-effort KV delete, then remove from MongoDB
      try {
        await store.deleteSecret(secretKvName(doc._id));
      } catch (err: any) {
        if (err?.statusCode !== 404) {
          console.warn(`[mcp-secret-routes] KV delete failed for ${doc._id}:`, err);
        }
      }

      await secretsCollection.deleteOne({ _id: doc._id as any });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
