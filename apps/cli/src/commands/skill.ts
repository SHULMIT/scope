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

export function registerSkillCommands(program: Command): void {
// ─── Skill management ────────────────────────────────────────────────────────

const skill = program
  .command("skill")
  .description("Manage agent skills (Agent Skills Specification)")
  .action(() => {
    skill.help();
  });

configureHelp(skill);

withProjectOption(withOutputOption(
skill
  .command("list")
  .description("List all imported skills")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
))
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    const projectId = requireProjectId(options.project);
    try {
      const response = await apiFetch(options.url, `/skills`, { projectId });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const skills = await response.json() as Array<{ _id: string; name: string; source: string; description?: string; origin: string }>;
      if (skills.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No skills found."));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`Found ${skills.length} skill(s):\n`));
      }
      const displayFields: DisplayField[] = [
        { key: '_id', label: 'Slug', tableFormatter: (s: any) => value(s._id) },
        { key: 'name', label: 'Name' },
        { key: 'source', label: 'Source' },
        { key: 'origin', label: 'Origin' },
        { key: 'description', label: 'Description', formatter: (s: any) => s.description || '—' },
      ];
      console.log(formatData(skills, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withProjectOption(withOutputOption(
skill
  .command("search")
  .description("Search skills in the internal library and the external skills.sh registry (content is always sourced from GitHub)")
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
      const response = await apiFetch(options.url, `/skills/search?${params}`, { projectId });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const results = await response.json() as Array<{ id: string; name: string; source: string; description?: string; internal: boolean; installs?: number }>;
      if (results.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No skills found."));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`Found ${results.length} result(s):\n`));
      }
      const displayFields: DisplayField[] = [
        { key: 'id', label: 'Slug', tableFormatter: (s: any) => value(s.id) },
        { key: 'name', label: 'Name' },
        { key: 'source', label: 'Source' },
        { key: 'internal', label: 'Imported', formatter: (s: any) => s.internal ? 'Yes' : 'No' },
        { key: 'installs', label: 'Installs', formatter: (s: any) => s.installs != null ? String(s.installs) : '—' },
        { key: 'description', label: 'Description', formatter: (s: any) => s.description || '—' },
      ];
      console.log(formatData(results, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withProjectOption(withOutputOption(
skill
  .command("get")
  .description("Get details of a skill")
  .requiredOption("-i, --id <id>", "Skill slug (e.g. vercel-labs/agent-skills/my-skill)")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
))
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const projectId = requireProjectId(options.project);
      const response = await apiFetch(options.url, `/skills/${options.id}`, { projectId });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const s = await response.json();

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: '_id', label: 'Slug' },
          { key: 'name', label: 'Name' },
          { key: 'source', label: 'Source' },
          { key: 'skillName', label: 'Skill Name' },
          { key: 'origin', label: 'Origin' },
          { key: 'description', label: 'Description', formatter: (sk: any) => sk.description || '' },
          { key: 'createdAt', label: 'Created' },
          { key: 'updatedAt', label: 'Updated' },
        ];
        console.log(formatData([s], fields, format));
        return;
      }

      console.log(`${label('Slug:')} ${value(s._id)}`);
      console.log(`${label('Name:')} ${value(s.name)}`);
      console.log(`${label('Source:')} ${value(s.source)}`);
      console.log(`${label('Skill Name:')} ${value(s.skillName)}`);
      console.log(`${label('Origin:')} ${value(s.origin)}`);
      if (s.description) console.log(`${label('Description:')} ${s.description}`);
      console.log(`${label('Created:')} ${new Date(s.createdAt).toLocaleString()}`);
      if (s.updatedAt) console.log(`${label('Updated:')} ${new Date(s.updatedAt).toLocaleString()}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

skill
  .command("import")
  .description("Import a skill from a GitHub repository into the internal library")
  .requiredOption("--source <source>", "GitHub repo (e.g. vercel-labs/agent-skills)")
  .requiredOption("--skill-name <name>", "Skill directory name within the repo")
  .requiredOption("--name <displayName>", "Display name")
  .option("--description <desc>", "Description")
  .option("--origin <origin>", "Origin: skills-sh or manual", "manual")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
  .option("--project <id>", "Project ID for scoped operations (overrides SCOPE_PROJECT and the saved selection)")
  .action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      const body: Record<string, unknown> = {
        source: options.source,
        skillName: options.skillName,
        name: options.name,
        origin: options.origin,
      };
      if (options.description) body.description = options.description;

      const response = await apiFetch(options.url, `/skills`, {
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
      console.log(successText(`Skill "${created._id}" imported.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withProjectOption(
skill
  .command("delete")
  .description("Delete a skill (soft-delete)")
  .requiredOption("-i, --id <id>", "Skill slug")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
)
  .action(async (options) => {
    try {
      const projectId = requireProjectId(options.project);
      const response = await apiFetch(options.url, `/skills/${options.id}`, {
        method: "DELETE",
        projectId,
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      console.log(successText(`Skill "${options.id}" deleted.`));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withProjectOption(withOutputOption(
skill
  .command("resolve")
  .description("Resolve a skill from GitHub (fetch latest version and create a revision)")
  .requiredOption("-i, --id <id>", "Skill slug")
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
))
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const projectId = requireProjectId(options.project);
      const response = await apiFetch(options.url, `/skills/${options.id}/resolve`, {
        method: "POST",
        projectId,
      });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const revision = await response.json();

      if (isMachineReadable(format)) {
        const fields: DisplayField[] = [
          { key: 'ref', label: 'Ref' },
          { key: 'commitHash', label: 'Commit' },
          { key: 'description', label: 'Description', formatter: (r: any) => r.description || '' },
          { key: 'archiveUrl', label: 'Archive URL', formatter: (r: any) => r.archiveUrl || '' },
        ];
        console.log(formatData([revision], fields, format));
        return;
      }

      console.log(successText(`Skill resolved to revision:`));
      console.log(`${label('Ref:')} ${value(revision.ref)}`);
      console.log(`${label('Commit:')} ${value(revision.commitHash)}`);
      console.log(`${label('Description:')} ${revision.description || '—'}`);
      if (revision.archiveUrl) console.log(`${label('Archive:')} ${value(revision.archiveUrl)}`);
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

withProjectOption(withOutputOption(
skill
  .command("revisions")
  .description("List revisions for a skill")
  .requiredOption("-i, --id <id>", "Skill slug")
  .option("--limit <number>", "Maximum results", parseInt)
  .option("-u, --url <url>", "API base URL", getDefaultApiUrl())
))
  .action(async (options) => {
    const format = (options.output || 'table') as OutputFormat;
    try {
      const projectId = requireProjectId(options.project);
      const params = options.limit ? `?limit=${options.limit}` : '';
      const response = await apiFetch(options.url, `/skills/${options.id}/revisions${params}`, { projectId });
      if (!response.ok) {
        const error = await response.json();
        console.error(errorText("Error:"), error.error || JSON.stringify(error));
        process.exit(1);
      }
      const revisions = await response.json() as Array<{ ref: string; commitHash: string; name: string; resolvedAt: string }>;
      if (revisions.length === 0) {
        if (!isMachineReadable(format)) console.log(warnBanner("No revisions found."));
        return;
      }
      if (!isMachineReadable(format)) {
        console.log(label(`Found ${revisions.length} revision(s):\n`));
      }
      const displayFields: DisplayField[] = [
        { key: 'ref', label: 'Ref', tableFormatter: (r: any) => value(r.ref) },
        { key: 'commitHash', label: 'Commit', formatter: (r: any) => r.commitHash.substring(0, 8) },
        { key: 'name', label: 'Name' },
        { key: 'resolvedAt', label: 'Resolved', formatter: (r: any) => new Date(r.resolvedAt).toLocaleString() },
      ];
      console.log(formatData(revisions, displayFields, format));
    } catch (error) {
      console.error(errorText("Error:"), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

}
