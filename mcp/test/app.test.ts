import { once } from "node:events";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const clients: Client[] = [];
const listeners: Array<ReturnType<Awaited<ReturnType<typeof createApp>>["app"]["listen"]>> = [];

function requestWithHost(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port, path: "/health", headers: { host } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode || 0));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(listeners.splice(0).map(async (listener) => {
    listener.close();
    await once(listener, "close");
  }));
});

describe("private MCP HTTP app", () => {
  it("advertises the focused tool surface over streamable HTTP", async () => {
    const config = loadConfig({
      MCP_WORKSPACE_ROOT: "..",
      MCP_HOST: "127.0.0.1",
      MCP_PORT: "3001",
    });
    const { app } = await createApp(config);
    const listener = app.listen(0, "127.0.0.1");
    listeners.push(listener);
    await once(listener, "listening");
    const address = listener.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", service: "cloner-template-mcp" });
    expect(await requestWithHost(address.port, "host.docker.internal")).toBe(200);
    expect(await requestWithHost(address.port, "attacker.example")).toBe(403);

    const client = new Client({ name: "cloner-template-test", version: "0.1.0" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "inspect_site",
      "list_workspace_files",
      "read_workspace_file",
      "write_workspace_files",
      "get_workspace_status",
      "start_quality_check",
      "get_quality_check",
      "check_preview",
    ]);
    expect(tools.tools.find((tool) => tool.name === "inspect_site")?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: true,
    });
    expect(tools.tools.find((tool) => tool.name === "write_workspace_files")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });
});
