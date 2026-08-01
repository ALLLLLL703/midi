import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { SecureHttpsDownloader } from "../services/https-downloader.js";
import { MuscriptorService } from "../services/muscriptor.js";
import { NodeProcessRunner } from "../services/process-runner.js";
import { SerialQueue } from "../services/serial-queue.js";
import { SourceResolver } from "../services/source-resolver.js";
import { registerTools } from "../tools/register-tools.js";
import { LeadVocalService } from "../services/lead-vocal.js";

/** Composes a midi MCP server with production service implementations. */
export function createServer(config: RuntimeConfig): McpServer {
  const server = new McpServer({ name: "midi", version: "0.1.0" });
  const downloader = new SecureHttpsDownloader(
    config.downloadMaxBytes,
    config.downloadTimeoutMs,
  );
  const sourceResolver = new SourceResolver(config, downloader);
  const runner = new NodeProcessRunner();
  const leadVocal = new LeadVocalService(config, runner);
  const muscriptor = new MuscriptorService(config, runner, new SerialQueue(), leadVocal);
  registerTools(server, sourceResolver, muscriptor);
  return server;
}
