// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Command } from "commander";
import { configureHelp } from "../utils/helpFormatter.js";
import { dimTimestamp, errorText, successText, label, value, warnBanner } from "../utils/style.js";
import { formatData, isMachineReadable } from "../utils/formatters.js";
import type { OutputFormat, DisplayField } from "../utils/types.js";
import { withOutputOption, withProjectOption, getDefaultApiUrl } from "../utils/shared.js";
import { requireProjectId } from "../utils/config.js";
import { apiFetch } from "../utils/api-client.js";

export function registerExtensionCommands(program: Command): void {
// ─── Extension management ────────────────────────────────────────────────────

const extension = program
  .command("extension")
  .description("Manage VS Code extensions")
  .action(() => {
    extension.help();
  });

configureHelp(extension);

withProjectOption(withOutputOption(
extension
  .command("list")
  .description("List all imported extensions")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
))
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    const projectId = requireProjectId(options.project);
    try {
      const response = await apiFetch(options.url, `/extensions`, { projectId });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const extensions = await response.json() as Array<{ _id: string; name: string; publisher: string; description?: string; version?: string; origin: string }>;
      if (extensions.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No extensions found."));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`Found ${extensions.length} extension(s):\n`));
      }
      const displayFields: DisplayField[] = [
        { key: '_id', label: 'ID', tableFormatter: (e: any) => value(e._id) },
        { key: 'name', label: 'Name' },
        { key: 'publisher', label: 'Publisher' },
        { key: 'origin', label: 'Origin' },
        { key: 'description', label: 'Description', formatter: (e: any) => e.description || '—' },
      ];
      console.log(formatData(extensions, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withProjectOption(withOutputOption(
extension
  .command("search")
  .description("Search extensions (internal + VS Code marketplace)")
  .requiredOption("-q, --query <query>", "Search query")
  .option("--limit <number>", "Maximum results", parseInt)
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
))
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    const projectId = requireProjectId(options.project);
    try {
      const params = new URLSearchParams({ q: options.query });
      if (options.limit) params.set('limit', String(options.limit));
      const response = await apiFetch(options.url, `/extensions/search?${params}`, { projectId });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const results = await response.json() as Array<{ id: string; name: string; publisher: string; description?: string; internal: boolean; version?: string }>;
      if (results.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No extensions found."));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`Found ${results.length} result(s):\n`));
      }
      const displayFields: DisplayField[] = [
        { key: 'id', label: 'ID', tableFormatter: (e: any) => value(e.id) },
        { key: 'name', label: 'Name' },
        { key: 'publisher', label: 'Publisher' },
        { key: 'internal', label: 'Imported', formatter: (e: any) => e.internal ? 'Yes' : 'No' },
        { key: 'description', label: 'Description', formatter: (e: any) => e.description || '—' },
      ];
      console.log(formatData(results, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withProjectOption(withOutputOption(
extension
  .command("get")
  .description("Get details of an extension")
  .requiredOption("-i, --id <id>", "Extension ID (e.g. ms-python.python)")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
))
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const projectId = requireProjectId(options.project);
      const response = await apiFetch(options.url, `/extensions/${options.id}`, { projectId });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const e = await response.json();

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: '_id', label: 'ID' },
          { key: 'name', label: 'Name' },
          { key: 'publisher', label: 'Publisher' },
          { key: 'origin', label: 'Origin' },
          { key: 'description', label: 'Description', formatter: (ext: any) => ext.description || '' },
          { key: 'createdAt', label: 'Created' },
          { key: 'updatedAt', label: 'Updated' },
        ];
        console.log(formatData([e], fields, format));
        return;
      }

      console.log(`${label('ID:')} ${value(e._id)}`);
      console.log(`${label('Name:')} ${value(e.name)}`);
      console.log(`${label('Publisher:')} ${value(e.publisher)}`);
      console.log(`${label('Origin:')} ${value(e.origin)}`);
      if (e.description) console.log(`${label('Description:')} ${e.description}`);
      console.log(`${label('Created:')} ${new Date(e.createdAt).toLocaleString()}`);
      if (e.updatedAt) console.log(`${label('Updated:')} ${new Date(e.updatedAt).toLocaleString()}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

extension
  .command("import")
  .description("Import a VS Code extension")
  .requiredOption("-i, --id <id>", "Extension ID (e.g. ms-python.python)")
  .requiredOption("--name <displayName>", "Display name")
  .option("--publisher <publisher>", "Publisher name (auto-extracted from ID if omitted)")
  .option("--description <desc>", "Description")
  .option("--origin <origin>", "Origin: marketplace or manual", "manual")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .option("--project <id>", "Project ID for scoped operations (overrides SCOPE_PROJECT and the saved selection)")
  .action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      const publisher = options.publisher || options.id.split('.')[0];
      const body: Record<string, unknown> = {
        _id: options.id,
        publisher,
        name: options.name,
        origin: options.origin,
      };
      if (options.description) body.description = options.description;

      const response = await apiFetch(options.url, `/extensions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        projectId,
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const created = await response.json();
      console.log(successText(`Extension "${created._id}" imported.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withProjectOption(
extension
  .command("delete")
  .description("Delete an extension (soft-delete)")
  .requiredOption("-i, --id <id>", "Extension ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
)
  .action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      const response = await apiFetch(options.url, `/extensions/${options.id}`, {
        method: "DELETE",
        projectId,
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText(`Extension "${options.id}" deleted.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

}
