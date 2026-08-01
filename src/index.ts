#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./app/create-server.js";
import { loadRuntimeConfig } from "./config/runtime-config.js";
import { translate } from "./i18n/translator.js";

async function main(): Promise<void> {
  const server = createServer(loadRuntimeConfig());
  await server.connect(new StdioServerTransport());
  console.error(JSON.stringify({ event: "server.started", message: translate("serverStarted") }));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
