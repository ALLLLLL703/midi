import { randomUUID } from "node:crypto";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, extname, join } from "node:path";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { AppError } from "../util/app-error.js";
import { ensureWritableDirectory } from "../util/path-security.js";
import type { ProcessRunner } from "./process-runner.js";
import { SerialQueue } from "./serial-queue.js";

export type ModelVariant = "small" | "medium" | "large";
export type Device = "auto" | "cpu" | "cuda" | `cuda:${number}` | "mps";
export type Dtype = "float32" | "float16" | "bfloat16";
export type TempoDetection = "true" | "false" | "best-effort";

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
  readonly detectTempo: TempoDetection;
}

export interface TranscriptionResult {
  readonly outputPath: string;
  readonly outputBytes: number;
  readonly model: ModelVariant;
  readonly sourceKind: "local" | "url";
}

export interface HealthReport {
  readonly ready: boolean;
  readonly cli: { readonly ok: boolean; readonly detail: string };
  readonly outputDirectory: { readonly ok: boolean; readonly detail: string };
  readonly authentication: { readonly status: "configured" | "unknown"; readonly detail: string };
}

function safeStem(inputPath: string): string {
  const stem = basename(inputPath, extname(inputPath))
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return stem || "transcription";
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
    "--detect-tempo",
    options.detectTempo,
    options.preludeForcing ? "--prelude-forcing" : "--no-prelude-forcing",
  ];
  if (options.dtype) arguments_.push("--dtype", options.dtype);
  if (options.instruments?.length) arguments_.push("--instruments", options.instruments.join(","));
  if (options.sampling) arguments_.push("--sampling");
  if (options.batchSize !== undefined) arguments_.push("--batch-size", String(options.batchSize));
  if (options.strictEos) arguments_.push("--strict-eos");
  return arguments_;
}

/** Shell-free adapter around the official MuScriptor CLI. */
export class MuscriptorService {
  public constructor(
    private readonly config: RuntimeConfig,
    private readonly runner: ProcessRunner,
    private readonly queue: SerialQueue,
  ) {}

  public async transcribe(
    audioPath: string,
    sourceKind: "local" | "url",
    options: TranscriptionOptions,
  ): Promise<TranscriptionResult> {
    await ensureWritableDirectory(this.config.outputDirectory);
    const outputPath = join(
      this.config.outputDirectory,
      `${safeStem(audioPath)}-${randomUUID()}.mid`,
    );
    return this.queue.run(async () => {
      console.error(JSON.stringify({ event: "transcription.started", model: options.model, sourceKind }));
      const result = await this.runner.run(
        this.config.muscriptorCommand,
        buildTranscriptionArguments(audioPath, outputPath, options),
        this.config.processTimeoutMs,
      );
      if (result.exitCode !== 0) {
        throw new AppError(
          "MUSCRIPTOR_FAILED",
          result.stderr.trim() || `MuScriptor exited with code ${result.exitCode}.`,
        );
      }
      try {
        await access(outputPath, constants.R_OK);
      } catch (error) {
        throw new AppError("MIDI_OUTPUT_MISSING", "MuScriptor completed without creating a readable MIDI file.", {
          cause: error,
        });
      }
      const output = await stat(outputPath);
      console.error(JSON.stringify({ event: "transcription.completed", outputPath, outputBytes: output.size }));
      return { outputPath, outputBytes: output.size, model: options.model, sourceKind };
    });
  }

  public async checkHealth(environment: NodeJS.ProcessEnv = process.env): Promise<HealthReport> {
    let cli: HealthReport["cli"];
    try {
      const result = await this.runner.run(this.config.muscriptorCommand, ["--help"], 30_000);
      cli = result.exitCode === 0
        ? { ok: true, detail: "MuScriptor CLI is available." }
        : { ok: false, detail: result.stderr.trim() || `MuScriptor exited with code ${result.exitCode}.` };
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
    };
  }
}
