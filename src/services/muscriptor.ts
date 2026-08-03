import { randomUUID } from "node:crypto";
import { access, chmod, link, readFile, rename, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, extname, join } from "node:path";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { AppError } from "../util/app-error.js";
import { ensurePrivateSubdirectory, ensureWritableDirectory } from "../util/path-security.js";
import type { ProcessRunner } from "./process-runner.js";
import { SerialQueue } from "./serial-queue.js";
import { parseMidi } from "midi-file";
import type { LeadVocalHealth, LeadVocalProcessor } from "./lead-vocal.js";

export type ModelVariant = "small" | "medium" | "large";
export type Device = "auto" | "cpu" | "cuda" | `cuda:${number}` | "mps" | "xpu";
export type Dtype = "float32" | "float16" | "bfloat16";

export interface TranscriptionOptions {
  readonly model: ModelVariant;
  readonly device: string;
  readonly dtype?: Dtype | undefined;
  readonly instruments?: readonly string[] | undefined;
  readonly sampling: boolean;
  readonly temperature: number;
  readonly cfgCoef: number;
  readonly batchSize?: number | undefined;
  readonly strictEos: boolean;
  readonly beamSize: number;
  readonly preludeForcing: boolean;
  readonly emptyOutputRetries?: number | undefined;
  readonly emptyOutputTemperature?: number | undefined;
  readonly emptyOutputCfgCoef?: number | undefined;
  readonly emptyOutputBeamSize?: number | undefined;
  readonly includeLeadVocal: boolean;
  readonly leadVocalVelocity: number;
  readonly leadVocalAccompanimentVolume: number;
  readonly outputFileName?: string | undefined;
}

export interface TranscriptionResult {
  readonly outputPath: string;
  readonly outputBytes: number;
  readonly model: ModelVariant;
  readonly sourceKind: "local" | "url";
  readonly leadVocalIncluded: boolean;
  readonly leadVocalNotes?: number | undefined;
}

export interface HealthReport {
  readonly ready: boolean;
  readonly cli: { readonly ok: boolean; readonly detail: string };
  readonly outputDirectory: { readonly ok: boolean; readonly detail: string };
  readonly authentication: { readonly status: "configured" | "unknown"; readonly detail: string };
  readonly leadVocal: LeadVocalHealth;
}

const REQUIRED_TRANSCRIBE_FLAGS = [
  "--output",
  "--format",
  "--sampling",
  "--temperature",
  "--cfg-coef",
  "--model",
  "--device",
  "--dtype",
  "--batch-size",
  "--strict-eos",
  "--beam-size",
  "--prelude-forcing",
  "--instruments",
  "--empty-output-retries",
  "--empty-output-temperature",
  "--empty-output-cfg-coef",
  "--empty-output-beam-size",
] as const;

function safeStem(inputPath: string): string {
  const stem = basename(inputPath, extname(inputPath))
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return stem || "transcription";
}

/** Resolves a safe basename inside the dedicated output directory. */
export function customOutputPath(outputDirectory: string, fileName: string): string {
  const trimmed = fileName.trim();
  let hasControlCharacter = false;
  for (const character of trimmed) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) {
      hasControlCharacter = true;
      break;
    }
  }
  if (
    !trimmed
    || trimmed === "."
    || trimmed === ".."
    || trimmed.includes("/")
    || trimmed.includes("\\")
    || hasControlCharacter
  ) {
    throw new AppError(
      "INVALID_OUTPUT_FILE_NAME",
      "outputFileName must be a single safe file name without path separators.",
    );
  }
  const normalized = trimmed.toLowerCase().endsWith(".mid") ? trimmed : `${trimmed}.mid`;
  return join(outputDirectory, normalized);
}

/** Converts validated options into shell-free MuScriptor CLI arguments. */
export function buildTranscriptionArguments(
  audioPath: string,
  outputPath: string,
  options: TranscriptionOptions,
): string[] {
  const arguments_ = [
    "transcribe",
    audioPath,
    "--output",
    outputPath,
    "--format",
    "midi",
    "--model",
    options.model,
    "--device",
    options.device,
    "--temperature",
    String(options.temperature),
    "--cfg-coef",
    String(options.cfgCoef),
    "--beam-size",
    String(options.beamSize),
    options.preludeForcing ? "--prelude-forcing" : "--no-prelude-forcing",
  ];
  if (options.dtype) arguments_.push("--dtype", options.dtype);
  if (options.instruments?.length) arguments_.push("--instruments", options.instruments.join(","));
  if (options.sampling) arguments_.push("--sampling");
  if (options.batchSize !== undefined) arguments_.push("--batch-size", String(options.batchSize));
  if (options.strictEos) arguments_.push("--strict-eos");
  if (options.emptyOutputRetries !== undefined && options.emptyOutputRetries > 0) {
    arguments_.push("--empty-output-retries", String(options.emptyOutputRetries));
    if (options.emptyOutputTemperature !== undefined) {
      arguments_.push("--empty-output-temperature", String(options.emptyOutputTemperature));
    }
    if (options.emptyOutputCfgCoef !== undefined) {
      arguments_.push("--empty-output-cfg-coef", String(options.emptyOutputCfgCoef));
    }
    if (options.emptyOutputBeamSize !== undefined) {
      arguments_.push("--empty-output-beam-size", String(options.emptyOutputBeamSize));
    }
  }
  return arguments_;
}

/** Shell-free adapter around the official MuScriptor CLI. */
export class MuscriptorService {
  public constructor(
    private readonly config: RuntimeConfig,
    private readonly runner: ProcessRunner,
    private readonly queue: SerialQueue,
    private readonly leadVocal?: LeadVocalProcessor,
  ) {}

  public async transcribe(
    audioPath: string,
    sourceKind: "local" | "url",
    options: TranscriptionOptions,
    signal?: AbortSignal,
  ): Promise<TranscriptionResult> {
    await ensureWritableDirectory(this.config.outputDirectory);
    const customName = options.outputFileName;
    const outputPath = customName
      ? customOutputPath(this.config.outputDirectory, customName)
      : join(this.config.outputDirectory, `${safeStem(audioPath)}-${randomUUID()}.mid`);
    if (customName) {
      try {
        await access(outputPath, constants.F_OK);
        throw new AppError("OUTPUT_ALREADY_EXISTS", `Output file already exists: ${outputPath}`);
      } catch (error) {
        if (error instanceof AppError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const privateOutputDirectory = await ensurePrivateSubdirectory(
      this.config.outputDirectory,
      ".results",
    );
    return this.queue.run(async () => {
      console.error(JSON.stringify({ event: "transcription.started", model: options.model, sourceKind }));
      const partialPath = join(privateOutputDirectory, `${randomUUID()}.mid.part`);
      try {
        let leadVocalNotes: number | undefined;
        if (options.includeLeadVocal) {
          leadVocalNotes = await this.requireLeadVocal().enhance(
            audioPath,
            partialPath,
            {
              velocity: options.leadVocalVelocity,
              accompanimentVolume: options.leadVocalAccompanimentVolume,
            },
            options,
            signal,
          );
        } else {
          await this.runTranscription(audioPath, partialPath, options, signal);
        }
        try {
          await access(partialPath, constants.R_OK);
        } catch (error) {
          throw new AppError("MIDI_OUTPUT_MISSING", "MuScriptor completed without creating a readable MIDI file.", {
            cause: error,
          });
        }
        const midiBytes = await readFile(partialPath);
        try {
          const midi = parseMidi(midiBytes);
          if (midi.tracks.length === 0) throw new Error("MIDI contains no tracks");
        } catch {
          throw new AppError("INVALID_MIDI_OUTPUT", "MuScriptor produced an invalid MIDI file.");
        }
        if (signal?.aborted) {
          throw new AppError("CANCELLED", "Transcription was cancelled before publishing.");
        }
        const output = await stat(partialPath);
        await chmod(partialPath, 0o600);
        if (customName) {
          try {
            await link(partialPath, outputPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              throw new AppError("OUTPUT_ALREADY_EXISTS", `Output file already exists: ${outputPath}`);
            }
            throw error;
          }
        } else {
          await rename(partialPath, outputPath);
        }
        console.error(JSON.stringify({ event: "transcription.completed", outputPath, outputBytes: output.size }));
        return {
          outputPath,
          outputBytes: output.size,
          model: options.model,
          sourceKind,
          leadVocalIncluded: options.includeLeadVocal,
          ...(leadVocalNotes === undefined ? {} : { leadVocalNotes }),
        };
      } finally {
        await rm(partialPath, { force: true });
      }
    }, signal);
  }

  private requireLeadVocal(): LeadVocalProcessor {
    if (!this.leadVocal) {
      throw new AppError("LEAD_VOCAL_UNAVAILABLE", "Lead-vocal processing is not configured.");
    }
    return this.leadVocal;
  }

  private async runTranscription(
    audioPath: string,
    midiPath: string,
    options: TranscriptionOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.runner.run(
      this.config.muscriptorCommand,
      buildTranscriptionArguments(audioPath, midiPath, options),
      this.config.processTimeoutMs,
      signal,
    );
    if (result.exitCode !== 0) {
      throw new AppError(
        "MUSCRIPTOR_FAILED",
        result.stderr.trim() || `MuScriptor exited with code ${result.exitCode}.`,
      );
    }
  }

  public async checkHealth(environment: NodeJS.ProcessEnv = process.env): Promise<HealthReport> {
    let cli: HealthReport["cli"];
    try {
      const result = await this.runner.run(this.config.muscriptorCommand, ["transcribe", "--help"], 30_000);
      const missingFlags = REQUIRED_TRANSCRIBE_FLAGS.filter((flag) => !result.stdout.includes(flag));
      if (result.exitCode !== 0) {
        cli = { ok: false, detail: result.stderr.trim() || `MuScriptor exited with code ${result.exitCode}.` };
      } else if (missingFlags.length) {
        cli = { ok: false, detail: `MuScriptor is missing required CLI options: ${missingFlags.join(", ")}.` };
      } else {
        cli = { ok: true, detail: "MuScriptor CLI is available and compatible." };
      }
    } catch (error) {
      cli = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }

    let outputDirectory: HealthReport["outputDirectory"];
    try {
      await ensureWritableDirectory(this.config.outputDirectory);
      outputDirectory = { ok: true, detail: this.config.outputDirectory };
    } catch (error) {
      outputDirectory = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }

    const tokenConfigured = Boolean(environment.HF_TOKEN || environment.HUGGING_FACE_HUB_TOKEN);
    let leadVocal: LeadVocalHealth;
    try {
      leadVocal = this.leadVocal
        ? await this.leadVocal.checkHealth()
        : { ok: false, detail: "Lead-vocal processing is not configured." };
    } catch (error) {
      leadVocal = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    return {
      ready: cli.ok && outputDirectory.ok,
      cli,
      outputDirectory,
      authentication: tokenConfigured
        ? { status: "configured", detail: "A Hugging Face token environment variable is configured." }
        : {
            status: "unknown",
            detail: "No token environment variable was found. Cached Hugging Face login or cached weights may still work.",
          },
      leadVocal,
    };
  }
}
