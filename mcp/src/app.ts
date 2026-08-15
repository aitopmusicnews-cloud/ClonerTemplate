import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import type { McpConfig } from "./config.js";
import { createClonerMcpServer } from "./mcp/cloner-server.js";
import { WorkspaceStore } from "./workspace/workspace-store.js";

function localHostOnly() {
  const allowed = new Set(["127.0.0.1", "localhost", "::1", "host.docker.internal"]);
  return (req: Request, res: Response, next: NextFunction) => {
    const hostname = req.hostname.replace(/^\[|\]$/g, "");
    if (allowed.has(hostname)) {
      next();
      return;
    }
    res.status(403).json({ error: "Host is not allowed for this private MCP server." });
  };
}

function rateLimit(maxRequests: number, windowMs: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const current = buckets.get(key);
    const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
    bucket.count += 1;
    buckets.set(key, bucket);
    if (bucket.count > maxRequests) {
      res.status(429).json({ error: "Too many requests. Try again shortly." });
      return;
    }
    next();
  };
}

function methodNotAllowed(res: Response): void {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
}

export async function createApp(config: McpConfig, store = new WorkspaceStore(config)) {
  await store.initialize();
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(localHostOnly());
  app.use(rateLimit(180, 60_000));
  app.use(express.json({ limit: Math.min(16 * 1024 * 1024, config.maxFilesPerWrite * config.maxFileBytes + 1024 * 1024) }));

  app.get("/health", (_req, res) => res.json({ status: "ok", service: "cloner-template-mcp", version: "0.1.0" }));
  app.post("/mcp", async (req, res) => {
    const server = createClonerMcpServer(store);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    };
    res.once("close", () => void close());
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request failed", error instanceof Error ? error.message : error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error." }, id: null });
      }
      await close();
    }
  });
  app.get("/mcp", (_req, res) => methodNotAllowed(res));
  app.delete("/mcp", (_req, res) => methodNotAllowed(res));
  app.use((_req, res) => res.status(404).json({ error: "Not found." }));

  return { app, store };
}
