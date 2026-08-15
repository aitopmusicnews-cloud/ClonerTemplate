import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpConfig } from "../src/config.js";
import { WorkspaceStore } from "../src/workspace/workspace-store.js";

const execFileAsync = promisify(execFile);
let workspaceRoot = "";
let store: WorkspaceStore;

function testConfig(): McpConfig {
  return {
    host: "127.0.0.1",
    port: 3001,
    workspaceRoot,
    previewBaseUrl: "http://127.0.0.1:3000",
    maxFilesPerWrite: 25,
    maxFileBytes: 524_288,
    checkTimeoutMs: 30_000,
  };
}

async function git(...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: workspaceRoot });
}

async function waitForCheck(jobId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = store.getCheck(jobId);
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for quality check in test.");
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "cloner-mcp-test-"));
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await mkdir(path.join(workspaceRoot, "public"), { recursive: true });
  await mkdir(path.join(workspaceRoot, "docs", "research"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "src", "page.tsx"), "export const Page = () => <main>Before</main>;\n");
  await writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({
    name: "fixture",
    private: true,
    scripts: {
      lint: "node -e \"console.log('lint ok')\"",
      typecheck: "node -e \"console.log('typecheck ok')\"",
      build: "node -e \"console.log('build ok')\"",
    },
  }, null, 2));
  await git("init", "-b", "test-branch");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "MCP Test");
  await git("add", ".");
  await git("commit", "-m", "fixture");
  store = new WorkspaceStore(testConfig());
  await store.initialize();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe("WorkspaceStore", () => {
  it("lists and reads only approved text files", async () => {
    await writeFile(path.join(workspaceRoot, "public", "ignored.bin"), "binary-ish");
    const files = await store.listFiles();
    const source = await store.readFile("src/page.tsx");

    expect(files.map((file) => file.path)).toEqual(expect.arrayContaining(["package.json", "src/page.tsx"]));
    expect(files.map((file) => file.path)).not.toContain("public/ignored.bin");
    expect(source.content).toContain("Before");
    expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(store.readFile(".git/config")).rejects.toThrow(/Protected|not allowed/);
    await expect(store.readFile("mcp/src/server.ts")).rejects.toThrow(/not allowed/);
  });

  it("uses optimistic concurrency for edits and allows bounded new files", async () => {
    const source = await store.readFile("src/page.tsx");
    const result = await store.writeFiles([
      {
        path: "src/page.tsx",
        action: "write",
        content: "export const Page = () => <main>After</main>;\n",
        expectedSha256: source.sha256,
      },
      { path: "docs/research/notes.md", action: "write", content: "# Authorized notes\n" },
    ]);

    expect(result.changedPaths).toEqual(["src/page.tsx", "docs/research/notes.md"]);
    expect(result.status.branch).toBe("test-branch");
    expect(result.status.dirty).toBe(true);
    expect(await readFile(path.join(workspaceRoot, "src", "page.tsx"), "utf8")).toContain("After");
    await expect(store.writeFiles([{
      path: "src/page.tsx",
      action: "write",
      content: "stale",
      expectedSha256: source.sha256,
    }])).rejects.toThrow(/changed since/);
  });

  it("blocks unguarded, protected, traversal, duplicate, and symlink writes", async () => {
    await expect(store.writeFiles([{
      path: "src/page.tsx",
      action: "write",
      content: "unguarded",
    }])).rejects.toThrow(/expected_sha256/);
    await expect(store.writeFiles([{ path: "package.json", action: "write", content: "{}" }])).rejects.toThrow(/not allowed/);
    await expect(store.writeFiles([{ path: "src/../../outside.ts", action: "write", content: "bad" }])).rejects.toThrow(/Unsafe/);
    await expect(store.writeFiles([
      { path: "src/new.ts", action: "write", content: "one" },
      { path: "src/new.ts", action: "write", content: "two" },
    ])).rejects.toThrow(/same path/);

    await mkdir(path.join(workspaceRoot, "outside"));
    await symlink(path.join(workspaceRoot, "outside"), path.join(workspaceRoot, "src", "linked"));
    await expect(store.writeFiles([{ path: "src/linked/escape.ts", action: "write", content: "bad" }])).rejects.toThrow(/Symbolic links/);
  });

  it("runs only the fixed lint, typecheck, and build quality sequence", async () => {
    const started = store.startCheck();
    expect(() => store.startCheck()).toThrow(/already running/);
    const finished = await waitForCheck(started.id);

    expect(finished.status).toBe("succeeded");
    expect(finished.steps.map((step) => step.name)).toEqual(["lint", "typecheck", "build"]);
    expect(finished.steps.every((step) => step.status === "succeeded")).toBe(true);
  });

  it("reports preview reachability without starting a server", async () => {
    const reachable = await store.checkPreview(async () => new Response("<title>Local Preview</title>", { status: 200 }));
    const unreachable = await store.checkPreview(async () => { throw new Error("offline"); });

    expect(reachable).toEqual({
      url: "http://127.0.0.1:3000",
      reachable: true,
      status: 200,
      title: "Local Preview",
    });
    expect(unreachable).toEqual({ url: "http://127.0.0.1:3000", reachable: false });
  });
});
