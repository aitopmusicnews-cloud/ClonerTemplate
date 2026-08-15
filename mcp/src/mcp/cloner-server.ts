import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { inspectSite } from "../site/inspect-site.js";
import type { WorkspaceStore } from "../workspace/workspace-store.js";

const statusSchema = z.object({
  branch: z.string(),
  dirty: z.boolean(),
  statusLines: z.array(z.string()),
});
const checkStepSchema = z.object({
  name: z.enum(["lint", "typecheck", "build"]),
  status: z.enum(["succeeded", "failed"]),
  output: z.string(),
  truncated: z.boolean(),
});
const checkJobSchema = z.object({
  id: z.string(),
  status: z.enum(["running", "succeeded", "failed"]),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  steps: z.array(checkStepSchema),
});
const siteInspectionSchema = z.object({
  requestedUrl: z.string(),
  finalUrl: z.string(),
  title: z.string(),
  description: z.string(),
  language: z.string(),
  headings: z.array(z.object({ level: z.number().int().min(1).max(6), text: z.string() })),
  navigation: z.array(z.object({ text: z.string(), url: z.string() })),
  images: z.array(z.object({ alt: z.string(), url: z.string() })),
  colors: z.array(z.string()),
  fontFamilies: z.array(z.string()),
  forms: z.number().int().nonnegative(),
  textSample: z.string(),
  inspectedAt: z.string(),
  warnings: z.array(z.string()),
});

function success<T extends Record<string, unknown>>(message: string, structuredContent: T) {
  return { content: [{ type: "text" as const, text: message }], structuredContent };
}

function failure(error: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: (error instanceof Error ? error.message : "The operation failed.").slice(0, 24_000) }],
  };
}

export function createClonerMcpServer(store: WorkspaceStore): McpServer {
  const server = new McpServer(
    { name: "cloner-template", version: "0.1.0" },
    {
      capabilities: { logging: {} },
      instructions:
        "Operate only on websites the user owns or is authorized to reproduce. Obtain explicit permission before inspect_site. Follow the repository AGENTS.md and inspection guide. List and read current files before writing; existing files require the SHA-256 returned by read_workspace_file. Create original code and use only authorized assets. After writes, start_quality_check, poll get_quality_check, and check_preview. Never deploy or commit automatically.",
    },
  );

  server.registerTool(
    "inspect_site",
    {
      title: "Inspect an authorized public website",
      description:
        "Use after explicit confirmation that the user owns the public website or has permission to recreate it. Returns a bounded HTML design summary without private source code or downloaded assets.",
      inputSchema: {
        url: z.url().describe("Public standard-port HTTP or HTTPS URL."),
        authorization_confirmed: z.literal(true).describe("True only after the user explicitly confirms ownership or permission."),
      },
      outputSchema: { inspection: siteInspectionSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ url, authorization_confirmed }) => {
      try {
        const inspection = await inspectSite({ url, authorizationConfirmed: authorization_confirmed });
        return success(`Inspected ${inspection.finalUrl}.`, { inspection });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_workspace_files",
    {
      title: "List ClonerTemplate workspace files",
      description:
        "Use before reading or editing. Lists supported text files in src, public, docs/research, plus selected read-only project configuration files.",
      outputSchema: { files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative() })) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const files = await store.listFiles();
        return success(`Found ${files.length} visible workspace files.`, { files });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "read_workspace_file",
    {
      title: "Read a ClonerTemplate workspace file",
      description:
        "Use before changing an existing file. Returns its text and SHA-256 concurrency token; supply that token to write_workspace_files.",
      inputSchema: { path: z.string().min(1).max(300).describe("Repository-relative POSIX path.") },
      outputSchema: { path: z.string(), content: z.string(), sha256: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ path }) => {
      try {
        const file = await store.readFile(path);
        return success(`Read ${file.path}.`, file);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "write_workspace_files",
    {
      title: "Write guarded ClonerTemplate files",
      description:
        "Use to create, replace, or delete a bounded batch of text files under src, public, or docs/research. Existing files require the exact SHA-256 returned by read_workspace_file. Does not commit or deploy.",
      inputSchema: {
        changes: z.array(z.object({
          path: z.string().min(1).max(300),
          action: z.enum(["write", "delete"]),
          content: z.string().optional(),
          expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        })).min(1).max(25),
      },
      outputSchema: { changedPaths: z.array(z.string()), status: statusSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ changes }) => {
      try {
        const result = await store.writeFiles(changes.map((change) => ({
          path: change.path,
          action: change.action,
          ...(change.content !== undefined ? { content: change.content } : {}),
          ...(change.expected_sha256 !== undefined ? { expectedSha256: change.expected_sha256 } : {}),
        })));
        return success(
          result.changedPaths.length ? `Changed ${result.changedPaths.length} workspace file(s).` : "Files already matched; nothing changed.",
          result,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_workspace_status",
    {
      title: "Get Git workspace status",
      description: "Use after writes or before handoff to see the current branch and every tracked or untracked workspace change.",
      outputSchema: { status: statusSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const status = await store.status();
        return success(status.dirty ? `Workspace has ${status.statusLines.length} changed path(s).` : "Workspace is clean.", { status });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "start_quality_check",
    {
      title: "Start ClonerTemplate quality checks",
      description:
        "Use after workspace edits. Starts fixed lint, TypeScript, and Next.js build commands in the background and returns a job ID. It cannot run model-supplied shell text.",
      outputSchema: { job: checkJobSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const job = store.startCheck();
        return success(`Started quality check ${job.id}. Poll get_quality_check until it finishes.`, { job });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_quality_check",
    {
      title: "Get quality check results",
      description: "Use with the job ID returned by start_quality_check. Returns progress and bounded command output for repair loops.",
      inputSchema: { job_id: z.uuid() },
      outputSchema: { job: checkJobSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ job_id }) => {
      try {
        const job = store.getCheck(job_id);
        return success(`Quality check ${job.id} is ${job.status}.`, { job });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "check_preview",
    {
      title: "Check the local Next.js preview",
      description:
        "Use after the user starts npm run dev. Checks the configured local preview URL and returns reachability, status, and page title without starting or publishing a server.",
      outputSchema: {
        preview: z.object({
          url: z.string(),
          reachable: z.boolean(),
          status: z.number().int().optional(),
          title: z.string().optional(),
        }),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const preview = await store.checkPreview();
        return success(preview.reachable ? `Preview is reachable at ${preview.url}.` : `Preview is not reachable at ${preview.url}.`, { preview });
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
