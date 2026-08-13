import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpConfig } from "../config.js";
import { runProcess } from "./process.js";

export type WorkspaceFile = { path: string; bytes: number };
export type FileChange = {
  path: string;
  action: "write" | "delete";
  content?: string;
  expectedSha256?: string;
};
export type WorkspaceStatus = { branch: string; dirty: boolean; statusLines: string[] };
export type CheckStep = { name: "lint" | "typecheck" | "build"; status: "succeeded" | "failed"; output: string; truncated: boolean };
export type CheckJob = {
  id: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string;
  steps: CheckStep[];
};

const VISIBLE_ROOTS = ["src", "public", "docs/research"];
const WRITABLE_ROOTS = ["src/", "public/", "docs/research/"];
const READ_ONLY_ROOT_FILES = new Set([
  "AGENTS.md",
  "components.json",
  "next.config.ts",
  "package.json",
  "postcss.config.mjs",
  "tsconfig.json",
]);
const TEXT_EXTENSIONS = new Set([
  ".css", ".html", ".js", ".json", ".jsx", ".md", ".mjs", ".svg", ".ts", ".tsx", ".txt", ".webmanifest", ".xml",
]);
const HIDDEN_OR_BUILD_DIRECTORIES = new Set([".git", ".next", "dist", "node_modules", "out", "temp"]);
const SHA256 = /^[a-f0-9]{64}$/;

function hash(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function cleanRelativePath(input: string, forWrite: boolean): string {
  if (input.includes("\0") || input.includes("\\")) throw new Error("Paths must use safe POSIX-style separators.");
  const normalized = path.posix.normalize(input);
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`Unsafe workspace path: ${input}`);
  }
  if (normalized.split("/").some((segment) => segment.startsWith(".") || HIDDEN_OR_BUILD_DIRECTORIES.has(segment))) {
    throw new Error(`Protected workspace path: ${input}`);
  }
  const allowed = forWrite
    ? WRITABLE_ROOTS.some((root) => normalized.startsWith(root))
    : READ_ONLY_ROOT_FILES.has(normalized) || VISIBLE_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
  if (!allowed) throw new Error(`${forWrite ? "Writing" : "Reading"} is not allowed for: ${input}`);
  if (!TEXT_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase())) {
    throw new Error(`Only supported text files can be ${forWrite ? "written" : "read"}: ${input}`);
  }
  return normalized;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function assertNoSymlinkComponents(root: string, relative: string): Promise<void> {
  let current = root;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${relative}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export class WorkspaceStore {
  readonly config: McpConfig;
  private readonly checkJobs = new Map<string, CheckJob>();
  private activeCheckId?: string;

  constructor(config: McpConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    const packagePath = path.join(this.config.workspaceRoot, "package.json");
    const sourcePath = path.join(this.config.workspaceRoot, "src");
    if (!(await exists(packagePath)) || !(await exists(sourcePath))) {
      throw new Error("MCP_WORKSPACE_ROOT must point to a ClonerTemplate repository containing package.json and src/.");
    }
  }

  private absolute(relative: string): string {
    const absolute = path.resolve(this.config.workspaceRoot, ...relative.split("/"));
    const prefix = `${path.resolve(this.config.workspaceRoot)}${path.sep}`;
    if (!absolute.startsWith(prefix)) throw new Error("Invalid workspace path.");
    return absolute;
  }

  async listFiles(): Promise<WorkspaceFile[]> {
    await this.initialize();
    const results: WorkspaceFile[] = [];
    const walk = async (relativeDirectory: string): Promise<void> => {
      const absoluteDirectory = this.absolute(relativeDirectory);
      if (!(await exists(absoluteDirectory))) return;
      const entries = await readdir(absoluteDirectory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || HIDDEN_OR_BUILD_DIRECTORIES.has(entry.name)) continue;
        const relative = path.posix.join(relativeDirectory, entry.name);
        const absolute = this.absolute(relative);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(relative);
        else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          results.push({ path: relative, bytes: (await stat(absolute)).size });
          if (results.length > 1_000) throw new Error("Workspace contains too many visible files to list safely.");
        }
      }
    };
    for (const root of VISIBLE_ROOTS) await walk(root);
    for (const rootFile of READ_ONLY_ROOT_FILES) {
      const absolute = this.absolute(rootFile);
      if (await exists(absolute)) results.push({ path: rootFile, bytes: (await stat(absolute)).size });
    }
    return results.sort((a, b) => a.path.localeCompare(b.path));
  }

  async readFile(requestedPath: string): Promise<{ path: string; content: string; sha256: string }> {
    const relative = cleanRelativePath(requestedPath, false);
    await assertNoSymlinkComponents(this.config.workspaceRoot, relative);
    const absolute = this.absolute(relative);
    const details = await stat(absolute);
    if (!details.isFile() || details.size > this.config.maxFileBytes) {
      throw new Error("File is missing, not a regular text file, or exceeds the read limit.");
    }
    const content = await readFile(absolute, "utf8");
    return { path: relative, content, sha256: hash(content) };
  }

  async writeFiles(changes: FileChange[]): Promise<{ changedPaths: string[]; status: WorkspaceStatus }> {
    if (changes.length === 0 || changes.length > this.config.maxFilesPerWrite) {
      throw new Error(`Provide between 1 and ${this.config.maxFilesPerWrite} file changes.`);
    }
    const normalized = changes.map((change) => {
      const relative = cleanRelativePath(change.path, true);
      if (change.action === "write") {
        if (typeof change.content !== "string") throw new Error(`Write action requires content: ${change.path}`);
        if (Buffer.byteLength(change.content, "utf8") > this.config.maxFileBytes) {
          throw new Error(`File exceeds the ${this.config.maxFileBytes} byte limit: ${change.path}`);
        }
      }
      if (change.expectedSha256 !== undefined && !SHA256.test(change.expectedSha256)) {
        throw new Error(`expected_sha256 must be a lowercase SHA-256 digest: ${change.path}`);
      }
      return { ...change, path: relative };
    });
    if (new Set(normalized.map((change) => change.path)).size !== normalized.length) {
      throw new Error("A write batch cannot target the same path more than once.");
    }

    for (const change of normalized) {
      await assertNoSymlinkComponents(this.config.workspaceRoot, change.path);
      const absolute = this.absolute(change.path);
      const currentExists = await exists(absolute);
      if (currentExists) {
        if (!change.expectedSha256) throw new Error(`Read the current file and provide expected_sha256 before changing it: ${change.path}`);
        const current = await readFile(absolute);
        if (hash(current) !== change.expectedSha256) throw new Error(`File changed since it was read; read it again before writing: ${change.path}`);
      } else if (change.action === "delete") {
        throw new Error(`Cannot delete a missing file: ${change.path}`);
      }
    }

    const changedPaths: string[] = [];
    for (const change of normalized) {
      const absolute = this.absolute(change.path);
      if (change.action === "delete") {
        await rm(absolute, { force: false });
        changedPaths.push(change.path);
        continue;
      }
      if (await exists(absolute)) {
        const current = await readFile(absolute, "utf8");
        if (current === change.content) continue;
      }
      await mkdir(path.dirname(absolute), { recursive: true });
      const temporary = `${absolute}.${randomUUID()}.tmp`;
      await writeFile(temporary, change.content!, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, absolute);
      changedPaths.push(change.path);
    }
    return { changedPaths, status: await this.status() };
  }

  async status(): Promise<WorkspaceStatus> {
    const [branch, status] = await Promise.all([
      runProcess({ command: "git", args: ["branch", "--show-current"], cwd: this.config.workspaceRoot, timeoutMs: 10_000 }),
      runProcess({ command: "git", args: ["status", "--short", "--untracked-files=all"], cwd: this.config.workspaceRoot, timeoutMs: 10_000 }),
    ]);
    const statusLines = status.output ? status.output.split("\n") : [];
    return { branch: branch.output, dirty: statusLines.length > 0, statusLines };
  }

  startCheck(): CheckJob {
    if (this.activeCheckId) {
      const active = this.checkJobs.get(this.activeCheckId);
      if (active?.status === "running") throw new Error(`Quality check ${active.id} is already running.`);
    }
    const job: CheckJob = { id: randomUUID(), status: "running", startedAt: new Date().toISOString(), steps: [] };
    this.checkJobs.set(job.id, job);
    this.activeCheckId = job.id;
    void this.runCheck(job);
    return structuredClone(job);
  }

  getCheck(jobId: string): CheckJob {
    const job = this.checkJobs.get(jobId);
    if (!job) throw new Error("Quality check job was not found; it may have expired after a server restart.");
    return structuredClone(job);
  }

  private async runCheck(job: CheckJob): Promise<void> {
    for (const name of ["lint", "typecheck", "build"] as const) {
      try {
        const result = await runProcess({
          command: "npm",
          args: ["run", name],
          cwd: this.config.workspaceRoot,
          timeoutMs: this.config.checkTimeoutMs,
        });
        job.steps.push({ name, status: "succeeded", output: result.output, truncated: result.truncated });
      } catch (error) {
        job.steps.push({
          name,
          status: "failed",
          output: error instanceof Error ? error.message.slice(-24_000) : "Unknown quality check error.",
          truncated: false,
        });
        job.status = "failed";
        job.finishedAt = new Date().toISOString();
        return;
      }
    }
    job.status = "succeeded";
    job.finishedAt = new Date().toISOString();

    if (this.checkJobs.size > 20) {
      const oldest = [...this.checkJobs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
      if (oldest && oldest.id !== job.id) this.checkJobs.delete(oldest.id);
    }
  }

  async checkPreview(fetcher: typeof fetch = fetch): Promise<{ url: string; reachable: boolean; status?: number; title?: string }> {
    try {
      const response = await fetcher(this.config.previewBaseUrl, { redirect: "manual", signal: AbortSignal.timeout(3_000) });
      const html = (await response.text()).slice(0, 256_000);
      const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
      return { url: this.config.previewBaseUrl, reachable: response.ok, status: response.status, ...(title ? { title } : {}) };
    } catch {
      return { url: this.config.previewBaseUrl, reachable: false };
    }
  }
}
