// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Router } from "express";
import type { Collection } from "mongodb";
import {
  ENDPOINT_CAPABILITY_TYPES,
  parseAzureAiFoundrySecret,
  type AcquireEndpointRequest,
  type AcquireEndpointResponse,
  type KeyDocument,
} from "shared";
import type { SecretStore } from "./keyvault-store.js";
import { RoundRobinMap } from "./round-robin.js";

export function createEndpointRouter(
  collection: Collection<KeyDocument>,
  store: SecretStore,
): Router {
  const router = Router();
  const roundRobin = new RoundRobinMap<KeyDocument>();

  // Internal only, like /keys/acquire. Registration and validation remain in /keys.
  router.post("/api/v1/endpoints/acquire", async (req, res, next) => {
    try {
      const capability = (req.body as Partial<AcquireEndpointRequest> | null)?.capability;
      if (typeof capability !== "string" || !Object.hasOwn(ENDPOINT_CAPABILITY_TYPES, capability)) {
        res.status(400).json({
          error: `Invalid endpoint capability. Must be one of: ${Object.keys(ENDPOINT_CAPABILITY_TYPES).join(", ")}`,
        });
        return;
      }

      const endpoints = await collection.find({
        type: ENDPOINT_CAPABILITY_TYPES[capability],
        capabilities: { $in: [capability] },
        enabled: true,
        lastValidationStatus: "valid",
        deletedAt: { $exists: false },
      }).toArray();

      if (endpoints.length === 0) {
        res.status(404).json({ error: `No valid endpoints available for capability '${capability}'` });
        return;
      }

      const selected = roundRobin.next(capability, endpoints);
      const raw = await store.getSecret(selected.secretName);
      const credential = parseAzureAiFoundrySecret(raw);
      if (!credential) {
        throw new Error(`Invalid endpoint credential for key '${selected._id}'`);
      }

      await collection.updateOne(
        { _id: selected._id },
        { $inc: { acquireCount: 1 }, $set: { lastAcquiredAt: new Date() } },
      );

      const response: AcquireEndpointResponse = {
        endpoint: credential.endpoint,
        apiKey: credential.apiKey,
        ...(credential.model ? { deployment: credential.model } : {}),
      };
      res.json(response);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
