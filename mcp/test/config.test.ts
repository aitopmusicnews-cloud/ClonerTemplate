import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses private, bounded defaults", () => {
    const config = loadConfig({});

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3001);
    expect(config.workspaceRoot).toBe(path.resolve(".."));
    expect(config.previewBaseUrl).toBe("http://127.0.0.1:3000");
    expect(config.maxFilesPerWrite).toBe(25);
  });

  it("rejects accidental unauthenticated remote binding", () => {
    expect(() => loadConfig({ MCP_HOST: "0.0.0.0" })).toThrow(/Secure MCP Tunnel/);
  });

  it("validates environment limits and protocols", () => {
    expect(() => loadConfig({ MCP_PORT: "0" })).toThrow(/MCP_PORT/);
    expect(() => loadConfig({ MCP_PREVIEW_BASE_URL: "file:///tmp/site" })).toThrow(/http or https/);
  });
});
