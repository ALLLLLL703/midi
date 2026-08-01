import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import type { RuntimeConfig } from "../src/config/runtime-config.js";
import { MuscriptorService, type TranscriptionOptions } from "../src/services/muscriptor.js";
import type { ProcessRunner } from "../src/services/process-runner.js";
import { SerialQueue } from "../src/services/serial-queue.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "midi-service-"));
  temporaryDirectories.push(path);
  return path;
}

function config(outputDirectory: string): RuntimeConfig {
  return {
    muscriptorCommand: "muscriptor",
    allowedInputDirectories: [outputDirectory],
    outputDirectory,
    downloadMaxBytes: 1024,
    downloadTimeoutMs: 1000,
    processTimeoutMs: 1000,
  };
}

const options: TranscriptionOptions = {
  model: "medium",
  device: "auto",
  sampling: false,
  temperature: 1,
  cfgCoef: 1,
  strictEos: false,
  beamSize: 1,
  preludeForcing: true,
};

class OutputRunner implements ProcessRunner {
  public constructor(private readonly output: Buffer, private readonly exitCode = 0) {}

  public async run(_command: string, arguments_: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const outputIndex = arguments_.indexOf("--output") + 1;
    const outputPath = arguments_[outputIndex];
    if (!outputPath) throw new Error("Missing output argument");
    await writeFile(outputPath, this.output);
    return { exitCode: this.exitCode, stdout: "", stderr: this.exitCode ? "failed" : "" };
  }
}

describe("MuscriptorService", () => {
  it("validates and atomically publishes a MIDI result", async () => {
    const outputDirectory = await temporaryDirectory();
    const midi = Buffer.from([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96,
      0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 4, 0, 0xff, 0x2f, 0,
    ]);
    const service = new MuscriptorService(config(outputDirectory), new OutputRunner(midi), new SerialQueue());

    const result = await service.transcribe("/audio/song.wav", "local", options);

    expect(result.outputBytes).toBe(26);
    expect(result.outputPath).toMatch(/\.mid$/);
    expect(await readdir(outputDirectory)).toEqual([".results", expect.stringMatching(/\.mid$/)]);
    expect((await stat(result.outputPath)).mode & 0o777).toBe(0o600);
  });

  it("removes invalid partial output", async () => {
    const outputDirectory = await temporaryDirectory();
    const service = new MuscriptorService(
      config(outputDirectory),
      new OutputRunner(Buffer.from("not midi")),
      new SerialQueue(),
    );

    await expect(service.transcribe("/audio/song.wav", "local", options)).rejects.toMatchObject({
      code: "INVALID_MIDI_OUTPUT",
    });
    expect(await readdir(outputDirectory)).toEqual([".results"]);
    expect(await readdir(join(outputDirectory, ".results"))).toEqual([]);
  });

  it("removes partial output after a CLI failure", async () => {
    const outputDirectory = await temporaryDirectory();
    const service = new MuscriptorService(
      config(outputDirectory),
      new OutputRunner(Buffer.from("partial"), 1),
      new SerialQueue(),
    );

    await expect(service.transcribe("/audio/song.wav", "local", options)).rejects.toMatchObject({
      code: "MUSCRIPTOR_FAILED",
    });
    expect(await readdir(outputDirectory)).toEqual([".results"]);
    expect(await readdir(join(outputDirectory, ".results"))).toEqual([]);
  });
});
