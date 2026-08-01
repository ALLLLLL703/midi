import { delimiter, resolve } from "node:path";
import { z } from "zod";

const positiveInteger = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const environmentSchema = z.object({
  MIDI_MCP_MUSCRIPTOR_COMMAND: z.string().min(1).default("muscriptor"),
  MIDI_MCP_DEMUCS_COMMAND: z.string().min(1).default("demucs"),
  MIDI_MCP_DEMUCS_DEVICE: z.string().min(1).default("auto"),
  MIDI_MCP_BASIC_PITCH_COMMAND: z.string().min(1).default("basic-pitch"),
  MIDI_MCP_ALLOWED_INPUT_DIRS: z.string().optional(),
  MIDI_MCP_OUTPUT_DIR: z.string().optional(),
  MIDI_MCP_DOWNLOAD_MAX_BYTES: positiveInteger(200 * 1024 * 1024),
  MIDI_MCP_DOWNLOAD_TIMEOUT_MS: positiveInteger(5 * 60 * 1000),
  MIDI_MCP_PROCESS_TIMEOUT_MS: positiveInteger(60 * 60 * 1000),
});

/** Immutable runtime configuration loaded from the server environment. */
export interface RuntimeConfig {
  readonly muscriptorCommand: string;
  readonly demucsCommand: string;
  readonly demucsDevice: string;
  readonly basicPitchCommand: string;
  readonly allowedInputDirectories: readonly string[];
  readonly outputDirectory: string;
  readonly downloadMaxBytes: number;
  readonly downloadTimeoutMs: number;
  readonly processTimeoutMs: number;
}

/** Loads and validates a complete runtime configuration snapshot. */
export function loadRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): RuntimeConfig {
  const parsed = environmentSchema.parse(environment);
  const configuredDirectories = parsed.MIDI_MCP_ALLOWED_INPUT_DIRS
    ?.split(delimiter)
    .map((directory) => directory.trim())
    .filter(Boolean);

  return Object.freeze({
    muscriptorCommand: parsed.MIDI_MCP_MUSCRIPTOR_COMMAND,
    demucsCommand: parsed.MIDI_MCP_DEMUCS_COMMAND,
    demucsDevice: parsed.MIDI_MCP_DEMUCS_DEVICE,
    basicPitchCommand: parsed.MIDI_MCP_BASIC_PITCH_COMMAND,
    allowedInputDirectories: Object.freeze(
      (configuredDirectories?.length ? configuredDirectories : [workingDirectory]).map(
        (directory) => resolve(workingDirectory, directory),
      ),
    ),
    outputDirectory: resolve(
      workingDirectory,
      parsed.MIDI_MCP_OUTPUT_DIR ?? ".midi-output",
    ),
    downloadMaxBytes: parsed.MIDI_MCP_DOWNLOAD_MAX_BYTES,
    downloadTimeoutMs: parsed.MIDI_MCP_DOWNLOAD_TIMEOUT_MS,
    processTimeoutMs: parsed.MIDI_MCP_PROCESS_TIMEOUT_MS,
  });
}
