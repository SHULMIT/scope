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

export function registerInsightCommands(program: Command): void {
// ─── Insight management ──────────────────────────────────────────────────────

const insight = program
  .command("insight")
  .description("Manage insights discovered during report analysis")
  .action(() => {
    insight.help();
  });

configureHelp(insight);

withProjectOption(withOutputOption(
insight
  .command("list")
  .description("List all insights")
  .option("-q, --query <query>", "Search by keyword")
  .option("--blocked", "Show only blocked insights")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
))
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    const projectId = requireProjectId(options.project);
    try {
      const params = new URLSearchParams();
      if (options.query) params.set("q", options.query);
      if (options.blocked) params.set("blocked", "true");
      const qs = params.toString();
      const response = await apiFetch(options.url, `/insights${qs ? `?${qs}` : ""}`, { projectId });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const insights = await response.json();
      if (insights.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No insights found."));
        return;
      }
      const displayFields: DisplayField[] = [
        { key: '_id', label: 'ID', tableFormatter: (r: any) => value(r._id.slice(0, 8) + '…') },
        { key: 'title', label: 'Title', formatter: (r: any) => r.title.length > 60 ? r.title.slice(0, 57) + '…' : r.title },
        { key: 'category', label: 'Category', formatter: (r: any) => r.category || '—' },
        { key: 'referenceCount', label: 'Refs', formatter: (r: any) => String(r.referenceCount) },
        { key: 'votes', label: 'Votes', formatter: (r: any) => String(r.upvotes - r.downvotes) },
        { key: 'blocked', label: 'Blocked', formatter: (r: any) => r.blocked ? '✗' : '' },
        { key: 'createdBy', label: 'Source' },
      ];
      console.log(formatData(insights, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withOutputOption(
insight
  .command("get")
  .description("Get details of an insight (renders markdown description)")
  .requiredOption("-i, --id <id>", "Insight ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
, ['markdown'])
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const response = await apiFetch(options.url, `/insights/${encodeURIComponent(options.id)}`);
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const insightDoc = await response.json();

      if (format === 'markdown') {
        console.log(insightDoc.description);
        return;
      }

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: '_id', label: 'ID' },
          { key: 'title', label: 'Title' },
          { key: 'category', label: 'Category', formatter: (r: any) => r.category || '' },
          { key: 'tags', label: 'Tags', formatter: (r: any) => (r.tags ?? []).join(', ') },
          { key: 'votes', label: 'Votes', formatter: (r: any) => String(r.upvotes - r.downvotes) },
          { key: 'referenceCount', label: 'References', formatter: (r: any) => String(r.referenceCount) },
          { key: 'blocked', label: 'Blocked', formatter: (r: any) => r.blocked ? 'Yes' : 'No' },
          { key: 'createdBy', label: 'Created By' },
          { key: 'description', label: 'Description' },
          { key: 'createdAt', label: 'Created' },
          { key: 'updatedAt', label: 'Updated' },
        ];
        console.log(formatData([insightDoc], fields, format));
        return;
      }

      console.log(`${label('ID:')} ${value(insightDoc._id)}`);
      console.log(`${label('Title:')} ${value(insightDoc.title)}`);
      if (insightDoc.category) console.log(`${label('Category:')} ${insightDoc.category}`);
      if (insightDoc.tags?.length) console.log(`${label('Tags:')} ${insightDoc.tags.join(', ')}`);
      console.log(`${label('Votes:')} ▲${insightDoc.upvotes} ▼${insightDoc.downvotes} (net: ${insightDoc.upvotes - insightDoc.downvotes})`);
      console.log(`${label('References:')} ${insightDoc.referenceCount} reports`);
      console.log(`${label('Blocked:')} ${insightDoc.blocked ? 'Yes' : 'No'}`);
      console.log(`${label('Created by:')} ${insightDoc.createdBy}`);
      if (insightDoc.sourceReportId) console.log(`${label('Source report:')} ${insightDoc.sourceReportId}`);
      console.log(`${label('Created:')} ${new Date(insightDoc.createdAt).toLocaleString()}`);
      if (insightDoc.updatedAt) console.log(`${label('Updated:')} ${new Date(insightDoc.updatedAt).toLocaleString()}`);
      console.log(`\n${label('Description:')}\n${insightDoc.description}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

insight
  .command("create")
  .description("Create a new insight")
  .requiredOption("--title <title>", "Short summary (one line)")
  .requiredOption("--description <description>", "Markdown description")
  .option("--category <category>", "Category tag")
  .option("--tags <tags>", "Comma-separated tags")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .option("--project <id>", "Project ID for scoped operations (overrides SCOPE_PROJECT and the saved selection)")
  .action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      const body: Record<string, unknown> = {
        title: options.title,
        description: options.description,
        createdBy: "user",
      };
      if (options.category) body.category = options.category;
      if (options.tags) body.tags = options.tags.split(",").map((t: string) => t.trim()).filter(Boolean);

      const response = await apiFetch(options.url, `/insights`, {
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
      console.log(successText(`Insight created: ${created._id}`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

insight
  .command("update")
  .description("Update an insight")
  .requiredOption("-i, --id <id>", "Insight ID")
  .option("--title <title>", "New title")
  .option("--description <description>", "New markdown description")
  .option("--category <category>", "New category")
  .option("--tags <tags>", "New comma-separated tags")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .action(async (options) => {
    try {
      const body: Record<string, unknown> = {};
      if (options.title) body.title = options.title;
      if (options.description) body.description = options.description;
      if (options.category) body.category = options.category;
      if (options.tags) body.tags = options.tags.split(",").map((t: string) => t.trim()).filter(Boolean);
      if (Object.keys(body).length === 0) {
        console.error(errorText("Error: provide at least one field to update"));
        process.exit(1);
      }
      const response = await apiFetch(options.url, `/insights/${encodeURIComponent(options.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText(`Insight ${options.id} updated.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

insight
  .command("delete")
  .description("Delete an insight (soft-delete)")
  .requiredOption("-i, --id <id>", "Insight ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .action(async (options) => {
    try {
      const response = await apiFetch(options.url, `/insights/${encodeURIComponent(options.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText(`Insight ${options.id} deleted.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

insight
  .command("upvote")
  .description("Upvote an insight")
  .requiredOption("-i, --id <id>", "Insight ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .action(async (options) => {
    try {
      const response = await apiFetch(options.url, `/insights/${encodeURIComponent(options.id)}/upvote`, {
        method: "POST",
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const updated = await response.json();
      console.log(successText(`Upvoted. Score: ▲${updated.upvotes} ▼${updated.downvotes}`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

insight
  .command("downvote")
  .description("Downvote an insight")
  .requiredOption("-i, --id <id>", "Insight ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .action(async (options) => {
    try {
      const response = await apiFetch(options.url, `/insights/${encodeURIComponent(options.id)}/downvote`, {
        method: "POST",
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const updated = await response.json();
      console.log(successText(`Downvoted. Score: ▲${updated.upvotes} ▼${updated.downvotes}`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

insight
  .command("block")
  .description("Block an insight")
  .requiredOption("-i, --id <id>", "Insight ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .action(async (options) => {
    try {
      const response = await apiFetch(options.url, `/insights/${encodeURIComponent(options.id)}/block`, {
        method: "POST",
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText(`Insight ${options.id} blocked.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

insight
  .command("unblock")
  .description("Unblock an insight")
  .requiredOption("-i, --id <id>", "Insight ID")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .action(async (options) => {
    try {
      const response = await apiFetch(options.url, `/insights/${encodeURIComponent(options.id)}/unblock`, {
        method: "POST",
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText(`Insight ${options.id} unblocked.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

}
