import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { translate } from "../i18n/translator.js";
import type { SourceResolver } from "../services/source-resolver.js";
import type { MuscriptorService, TranscriptionOptions } from "../services/muscriptor.js";
import { AppError, errorMessage } from "../util/app-error.js";
import {
  assertCompatibleTranscriptionOptions,
  instrumentalAudioToMidiInputSchema,
  vocalAudioToMidiInputSchema,
} from "./schemas.js";

const transcriptionOutputSchema = z.object({
  outputPath: z.string(),
  outputBytes: z.number(),
  model: z.enum(["small", "medium", "large"]),
  sourceKind: z.enum(["local", "url"]),
  leadVocalIncluded: z.boolean(),
  leadVocalNotes: z.number().int().nonnegative().optional(),
});

const healthOutputSchema = z.object({
  ready: z.boolean(),
  cli: z.object({ ok: z.boolean(), detail: z.string() }),
  outputDirectory: z.object({ ok: z.boolean(), detail: z.string() }),
  authentication: z.object({
    status: z.enum(["configured", "unknown"]),
    detail: z.string(),
  }),
  leadVocal: z.object({ ok: z.boolean(), detail: z.string() }),
});

function toolError(error: unknown, fallback: string) {
  const message = error instanceof AppError ? error.message : fallback;
  console.error(JSON.stringify({ event: "tool.failed", error: errorMessage(error) }));
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

async function transcribeSource(
  source: string,
  options: TranscriptionOptions,
  signal: AbortSignal,
  sourceResolver: Pick<SourceResolver, "resolve">,
  muscriptor: Pick<MuscriptorService, "transcribe">,
) {
  let resolvedSource;
  try {
    resolvedSource = await sourceResolver.resolve(source, signal);
    const output = await muscriptor.transcribe(
      resolvedSource.path,
      resolvedSource.sourceKind,
      options,
      signal,
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output) }],
      structuredContent: { ...output },
    };
  } catch (error) {
    return toolError(error, translate("transcriptionFailed"));
  } finally {
    try {
      await resolvedSource?.cleanup();
    } catch (cleanupError) {
      console.error(JSON.stringify({ event: "source.cleanup_failed", error: errorMessage(cleanupError) }));
    }
  }
}

/** Registers the public midi MCP tool surface. */
export function registerTools(
  server: McpServer,
  sourceResolver: Pick<SourceResolver, "resolve">,
  muscriptor: Pick<MuscriptorService, "transcribe" | "checkHealth">,
): void {
  server.registerTool(
    "vocal_audio_to_midi",
    {
      description: translate("vocalAudioToMidiDescription"),
      inputSchema: vocalAudioToMidiInputSchema,
      outputSchema: transcriptionOutputSchema,
    },
    async (input, extra) => {
      try {
        assertCompatibleTranscriptionOptions(input);
        const { source, ...options } = input;
        return await transcribeSource(
          source,
          { ...options, includeLeadVocal: true },
          extra.signal,
          sourceResolver,
          muscriptor,
        );
      } catch (error) {
        return toolError(error, translate("transcriptionFailed"));
      }
    },
  );

  server.registerTool(
    "instrumental_audio_to_midi",
    {
      description: translate("instrumentalAudioToMidiDescription"),
      inputSchema: instrumentalAudioToMidiInputSchema,
      outputSchema: transcriptionOutputSchema,
    },
    async (input, extra) => {
      try {
        assertCompatibleTranscriptionOptions(input);
        const { source, ...options } = input;
        return await transcribeSource(
          source,
          {
            ...options,
            includeLeadVocal: false,
            leadVocalVelocity: 127,
            leadVocalAccompanimentVolume: 89,
          },
          extra.signal,
          sourceResolver,
          muscriptor,
        );
      } catch (error) {
        return toolError(error, translate("transcriptionFailed"));
      }
    },
  );

  server.registerTool(
    "check_model",
    {
      description: translate("checkModelDescription"),
      inputSchema: z.object({}),
      outputSchema: healthOutputSchema,
    },
    async () => {
      try {
        const report = await muscriptor.checkHealth();
        return {
          content: [{ type: "text", text: JSON.stringify(report) }],
          structuredContent: { ...report },
        };
      } catch (error) {
        return toolError(error, translate("healthCheckFailed"));
      }
    },
  );
}
