import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app } = await createApp(config);
const server = app.listen(config.port, config.host, () => {
  console.log(`ClonerTemplate MCP listening on http://${config.host}:${config.port}/mcp`);
});

function shutdown(signal: string): void {
  console.log(`Received ${signal}; shutting down.`);
  server.close((error) => {
    if (error) {
      console.error("Shutdown failed", error);
      process.exitCode = 1;
    }
    process.exit();
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
