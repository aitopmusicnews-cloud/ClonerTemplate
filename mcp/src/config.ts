import path from "node:path";

export type McpConfig = {
  port: number;
  host: string;
  workspaceRoot: string;
  previewBaseUrl: string;
  maxFilesPerWrite: number;
  maxFileBytes: number;
  checkTimeoutMs: number;
};

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function webBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MCP_PREVIEW_BASE_URL must use http or https.");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const host = env.MCP_HOST?.trim() || "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(
      "MCP_HOST must be a loopback address. Use OpenAI Secure MCP Tunnel for this private MVP.",
    );
  }

  return {
    port: integer(env, "MCP_PORT", 3001, 1, 65_535),
    host,
    workspaceRoot: path.resolve(env.MCP_WORKSPACE_ROOT || ".."),
    previewBaseUrl: webBaseUrl(env.MCP_PREVIEW_BASE_URL || "http://127.0.0.1:3000"),
    maxFilesPerWrite: integer(env, "MCP_MAX_FILES_PER_WRITE", 25, 1, 100),
    maxFileBytes: integer(env, "MCP_MAX_FILE_BYTES", 524_288, 1_024, 2_097_152),
    checkTimeoutMs: integer(env, "MCP_CHECK_TIMEOUT_MS", 300_000, 10_000, 900_000),
  };
}
