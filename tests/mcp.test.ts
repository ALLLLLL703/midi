import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import type { HealthReport, TranscriptionResult } from "../src/services/muscriptor.js";
import type { ResolvedSource } from "../src/services/source-resolver.js";
import { registerTools } from "../src/tools/register-tools.js";

async function connectedClient(
  source: ResolvedSource,
  transcription: TranscriptionResult,
  health: HealthReport,
) {
  const server = new McpServer({ name: "test-midi", version: "0.1.0" });
  const cleanup = vi.fn(() => Promise.resolve());
  registerTools(
    server,
    { resolve: vi.fn(() => Promise.resolve({ ...source, cleanup })) },
    {
      transcribe: vi.fn(() => Promise.resolve(transcription)),
      checkHealth: vi.fn(() => Promise.resolve(health)),
    },
  );
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, cleanup };
}

const health: HealthReport = {
  ready: true,
  cli: { ok: true, detail: "MuScriptor CLI is available." },
  outputDirectory: { ok: true, detail: "/output" },
  authentication: { status: "unknown", detail: "No token was found." },
};

describe("midi MCP tools", () => {
  it("lists and calls check_model through MCP", async () => {
    const { client } = await connectedClient(
      { path: "/audio/song.wav", sourceKind: "local", cleanup: () => Promise.resolve() },
      { outputPath: "/output/song.mid", outputBytes: 26, model: "medium", sourceKind: "local" },
      health,
    );

    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name)).toEqual(["audio_to_midi", "check_model"]);
    const audioToMidi = tools.tools.find(({ name }) => name === "audio_to_midi");
    expect(audioToMidi?.inputSchema.properties).toMatchObject({
      source: { type: "string" },
      model: { enum: ["small", "medium", "large"] },
    });
    expect(audioToMidi?.inputSchema.required).toContain("source");
    const result = await client.callTool({ name: "check_model", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ ready: true });
    await client.close();
  });

  it("transcribes with defaults and cleans a resolved source", async () => {
    const output = { outputPath: "/output/song.mid", outputBytes: 26, model: "medium" as const, sourceKind: "url" as const };
    const { client, cleanup } = await connectedClient(
      { path: "/tmp/song.wav", sourceKind: "url", cleanup: () => Promise.resolve() },
      output,
      health,
    );

    const result = await client.callTool({
      name: "audio_to_midi",
      arguments: { source: "https://example.com/song.wav" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(output);
    expect(cleanup).toHaveBeenCalledOnce();
    await client.close();
  });

  it("returns an MCP validation error for unsafe model values", async () => {
    const { client } = await connectedClient(
      { path: "/audio/song.wav", sourceKind: "local", cleanup: () => Promise.resolve() },
      { outputPath: "/output/song.mid", outputBytes: 26, model: "medium", sourceKind: "local" },
      health,
    );

    const result = await client.callTool({
      name: "audio_to_midi",
      arguments: { source: "/audio/song.wav", model: "https://internal/model" },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });
});
