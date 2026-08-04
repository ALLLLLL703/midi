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
  const transcribe = vi.fn(() => Promise.resolve(transcription));
  registerTools(
    server,
    { resolve: vi.fn(() => Promise.resolve({ ...source, cleanup })) },
    {
      transcribe,
      checkHealth: vi.fn(() => Promise.resolve(health)),
    },
  );
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, cleanup, transcribe };
}

const health: HealthReport = {
  ready: true,
  cli: { ok: true, detail: "MuScriptor CLI is available." },
  outputDirectory: { ok: true, detail: "/output" },
  authentication: { status: "unknown", detail: "No token was found." },
  leadVocal: { ok: true, detail: "Demucs is available; vocal stems use MuScriptor." },
};

describe("midi MCP tools", () => {
  it("lists and calls check_model through MCP", async () => {
    const { client } = await connectedClient(
      { path: "/audio/song.wav", sourceKind: "local", cleanup: () => Promise.resolve() },
      { outputPath: "/output/song.mid", outputBytes: 26, model: "medium", sourceKind: "local", leadVocalIncluded: false },
      health,
    );

    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name)).toEqual([
      "vocal_audio_to_midi",
      "instrumental_audio_to_midi",
      "check_model",
    ]);
    const vocalTool = tools.tools.find(({ name }) => name === "vocal_audio_to_midi");
    expect(vocalTool?.inputSchema.properties).toMatchObject({
      source: { type: "string" },
      outputFileName: { type: "string" },
      model: { enum: ["small", "medium", "large"], default: "large" },
      device: { default: "xpu" },
      dtype: { default: "float16" },
      cfgCoef: { default: 1 },
      beamSize: { default: 1 },
      emptyOutputRetries: { type: "integer", default: 3 },
      emptyOutputTemperature: { type: "number", default: 0.6 },
      emptyOutputCfgCoef: { type: "number", default: 1.75 },
      emptyOutputBeamSize: { type: "integer", default: 3 },
      leadVocalVelocity: { type: "integer", default: 127 },
      leadVocalAccompanimentVolume: { type: "integer", default: 89 },
    });
    expect(vocalTool?.inputSchema.properties).not.toHaveProperty("includeLeadVocal");
    expect(vocalTool?.inputSchema.required).toContain("source");
    const instrumentalTool = tools.tools.find(({ name }) => name === "instrumental_audio_to_midi");
    expect(instrumentalTool?.inputSchema.properties).toMatchObject({
      model: { default: "medium" },
      device: { default: "auto" },
      beamSize: { default: 1 },
    });
    expect(instrumentalTool?.inputSchema.properties).not.toHaveProperty("leadVocalVelocity");
    const result = await client.callTool({ name: "check_model", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ ready: true });
    await client.close();
  });

  it("transcribes with defaults and cleans a resolved source", async () => {
    const output = { outputPath: "/output/song.mid", outputBytes: 26, model: "medium" as const, sourceKind: "url" as const, leadVocalIncluded: false };
    const { client, cleanup, transcribe } = await connectedClient(
      { path: "/tmp/song.wav", sourceKind: "url", cleanup: () => Promise.resolve() },
      output,
      health,
    );

    const result = await client.callTool({
      name: "instrumental_audio_to_midi",
      arguments: { source: "https://example.com/song.wav" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(output);
    expect(transcribe).toHaveBeenCalledWith(
      "/tmp/song.wav",
      "url",
      expect.objectContaining({
        model: "medium",
        device: "auto",
        includeLeadVocal: false,
      }),
      expect.any(AbortSignal),
    );
    expect(cleanup).toHaveBeenCalledOnce();
    await client.close();
  });

  it("runs the vocal tool with approved defaults and mandatory enhancement", async () => {
    const output = {
      outputPath: "/output/song.mid",
      outputBytes: 26,
      model: "large" as const,
      sourceKind: "local" as const,
      leadVocalIncluded: true,
      leadVocalNotes: 12,
    };
    const { client, transcribe } = await connectedClient(
      { path: "/audio/song.wav", sourceKind: "local", cleanup: () => Promise.resolve() },
      output,
      health,
    );

    const result = await client.callTool({
      name: "vocal_audio_to_midi",
      arguments: { source: "/audio/song.wav" },
    });

    expect(result.isError).not.toBe(true);
    expect(transcribe).toHaveBeenCalledWith(
      "/audio/song.wav",
      "local",
      expect.objectContaining({
        model: "large",
        device: "xpu",
        dtype: "float16",
        beamSize: 1,
        cfgCoef: 1,
        emptyOutputRetries: 3,
        emptyOutputBeamSize: 3,
        includeLeadVocal: true,
      }),
      expect.any(AbortSignal),
    );
    await client.close();
  });

  it("returns an MCP validation error for unsafe model values", async () => {
    const { client } = await connectedClient(
      { path: "/audio/song.wav", sourceKind: "local", cleanup: () => Promise.resolve() },
      { outputPath: "/output/song.mid", outputBytes: 26, model: "medium", sourceKind: "local", leadVocalIncluded: false },
      health,
    );

    const result = await client.callTool({
      name: "instrumental_audio_to_midi",
      arguments: { source: "/audio/song.wav", model: "https://internal/model" },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });
});
