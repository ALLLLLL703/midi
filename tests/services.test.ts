import { describe, expect, it } from "vitest";
import { SerialQueue } from "../src/services/serial-queue.js";
import { buildTranscriptionArguments, type TranscriptionOptions } from "../src/services/muscriptor.js";
import { audioToMidiInputSchema } from "../src/tools/schemas.js";

const options: TranscriptionOptions = {
  model: "medium",
  device: "cuda:0",
  dtype: "float16",
  instruments: ["acoustic_piano", "drums"],
  sampling: true,
  temperature: 0.8,
  cfgCoef: 1,
  batchSize: 4,
  strictEos: true,
  beamSize: 2,
  preludeForcing: false,
};

describe("buildTranscriptionArguments", () => {
  it("maps every supported option to a shell-free argument", () => {
    expect(buildTranscriptionArguments("/audio/a.wav", "/output/a.mid", options)).toEqual([
      "transcribe", "/audio/a.wav", "--output", "/output/a.mid", "--format", "midi",
      "--model", "medium", "--device", "cuda:0", "--temperature", "0.8",
      "--cfg-coef", "1", "--beam-size", "2",
      "--no-prelude-forcing", "--dtype", "float16", "--instruments",
      "acoustic_piano,drums", "--sampling", "--batch-size", "4", "--strict-eos",
    ]);
  });
});

describe("audioToMidiInputSchema", () => {
  it("applies the selected medium model and safe MuScriptor defaults", () => {
    expect(audioToMidiInputSchema.parse({ source: "/audio/a.wav" })).toMatchObject({
      model: "medium",
      device: "auto",
      preludeForcing: true,
    });
  });

  it("rejects batching while prelude forcing is enabled", () => {
    expect(() => audioToMidiInputSchema.parse({ source: "/audio/a.wav", batchSize: 2 })).toThrow(
      "batchSize greater than 1 requires preludeForcing=false",
    );
  });

  it("rejects arbitrary model URLs", () => {
    expect(() => audioToMidiInputSchema.parse({ source: "/audio/a.wav", model: "https://example.com/model" })).toThrow();
  });
});

describe("SerialQueue", () => {
  it("runs jobs sequentially and continues after a failure", async () => {
    const queue = new SerialQueue();
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = queue.run(async () => {
      events.push("first:start");
      await gate;
      events.push("first:end");
      throw new Error("expected failure");
    });
    const second = queue.run(() => {
      events.push("second:start");
      return Promise.resolve("ok");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await expect(first).rejects.toThrow("expected failure");
    await expect(second).resolves.toBe("ok");
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });
});
