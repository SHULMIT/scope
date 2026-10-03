// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// --- MCP Server types ---

/** Supported MCP transport types */
export type McpTransportType = "sse" | "http" | "stdio";

/** MCP server session mode */
export type McpSessionMode = "stateful" | "stateless";

/** MCP server HTTP header (name-value pair) */
export interface McpServerHeader {
  name: string;
  value: string;
}

/** MCP server document stored in MongoDB */
export interface McpServerDocument {
  _id: string;                    // Opaque UUID (internal). Legacy rows (pre-migration 027) key _id to the slug.
  slug: string;                   // Human reference key (^[a-z0-9]([a-z0-9-]*[a-z0-9])?$); unique per project
  projectId: string;              // FK → ProjectDocument._id (immutable scope)
  name: string;                   // Human-readable display name
  type: McpTransportType;         // Transport type
  url?: string;                   // Server URL (required for sse/http)
  command?: string;               // Executable to spawn (required for stdio)
  args?: string[];                // CLI arguments for stdio command
  env?: Record<string, string>;   // Environment variables for stdio command
  headers?: McpServerHeader[];    // Auth headers, API keys, etc. (sse/http)
  sessionMode?: McpSessionMode;   // Gateway session mode (default: stateless for http, stateful for stdio)
  version?: string;               // Package version pin for stdio npm packages
  description?: string;
  createdAt: Date;
  updatedAt?: Date;
  deletedAt?: Date;               // Soft-delete timestamp
}

/** MCP server secret document stored in Token Manager MongoDB (values live in Key Vault only) */
export interface McpSecretDocument {
  _id: string;        // MongoDB ObjectId as hex string
  projectId: string;  // FK → ProjectDocument._id (immutable scope; secrets isolate per project)
  mcpId: string;      // McpServerDocument.slug (e.g. "azure")
  name: string;       // Secret name (e.g. "AZURE_CLIENT_SECRET" or "Authorization")
  createdAt: Date;
  updatedAt: Date;
}

/** Resolved MCP server configuration passed to workers at runtime */
export interface McpServerConfig {
  type: McpTransportType;
  slug: string;                   // Gateway-safe identifier (^[a-zA-Z0-9_-]+$), maps from McpServerDocument.slug; used for secret resolution
  name: string;                   // Human-readable display name
  url?: string;                   // required for sse/http
  command?: string;               // required for stdio
  args?: string[];
  env?: Record<string, string>;
  headers?: McpServerHeader[];
  sessionMode?: McpSessionMode;
  version?: string;
}
