import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import ToneMidi from "@tonejs/midi";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import type { RuntimeConfig } from "../src/config/runtime-config.js";
import { LeadVocalService, mergeLeadVocalMidi } from "../src/services/lead-vocal.js";
import type { TranscriptionOptions } from "../src/services/muscriptor.js";
import type { ProcessResult, ProcessRunner } from "../src/services/process-runner.js";
import { parseMidi, writeMidi, type MidiData, type MidiEvent } from "midi-file";

const temporaryDirectories: string[] = [];
const { Midi } = ToneMidi;
const transcription: TranscriptionOptions = {
  model: "large",
  device: "xpu",
  dtype: "float16",
  instruments: ["guitar"],
  sampling: false,
  temperature: 1,
  cfgCoef: 1.5,
  batchSize: 1,
  strictEos: false,
  beamSize: 3,
  preludeForcing: true,
  emptyOutputRetries: 3,
  emptyOutputTemperature: 0.6,
  emptyOutputCfgCoef: 1.75,
  emptyOutputBeamSize: 3,
  includeLeadVocal: true,
  leadVocalVelocity: 127,
  leadVocalAccompanimentVolume: 89,
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "lead-vocal-"));
  temporaryDirectories.push(path);
  return path;
}

function midiWithTrack(name: string, program: number, note: number, time: number): Buffer {
  const midi = new Midi();
  const track = midi.addTrack();
  track.name = name;
  track.instrument.number = program;
  track.addNote({ midi: note, time, duration: 0.5, velocity: 0.8 });
  return Buffer.from(midi.toArray());
}

function vocalStemMidi(): Buffer {
  const midi = new Midi();
  const voice = midi.addTrack();
  voice.name = "voice";
  voice.instrument.number = 52;
  voice.addNote({ midi: 64, time: 1.25, duration: 0.5, velocity: 0.8 });
  const guitar = midi.addTrack();
  guitar.name = "acoustic guitar";
  guitar.instrument.number = 24;
  guitar.addNote({ midi: 67, time: 2.25, duration: 0.5, velocity: 0.8 });
  return Buffer.from(midi.toArray());
}

function config(outputDirectory: string): RuntimeConfig {
  return {
    muscriptorCommand: "muscriptor",
    demucsCommand: "demucs",
    demucsDevice: "xpu",
    allowedInputDirectories: [outputDirectory],
    outputDirectory,
    downloadMaxBytes: 1024,
    downloadTimeoutMs: 1000,
    processTimeoutMs: 1000,
  };
}

class PipelineRunner implements ProcessRunner {
  public readonly calls: { command: string; arguments_: readonly string[] }[] = [];

  public constructor(private readonly omitAccompaniment = false) {}

  public async run(command: string, arguments_: readonly string[]): Promise<ProcessResult> {
    this.calls.push({ command, arguments_ });
    if (command === "demucs") {
      const outputDirectory = arguments_[arguments_.indexOf("--out") + 1];
      const inputPath = arguments_.at(-1);
      if (!outputDirectory || !inputPath) throw new Error("Invalid Demucs arguments");
      const stem = basename(inputPath, extname(inputPath));
      const stemDirectory = join(outputDirectory, "htdemucs", stem);
      await mkdir(stemDirectory, { recursive: true });
      await writeFile(join(stemDirectory, "vocals.wav"), "vocal audio");
      if (!this.omitAccompaniment) {
        await writeFile(join(stemDirectory, "no_vocals.wav"), "accompaniment audio");
      }
    } else if (command === "muscriptor") {
      const inputPath = arguments_[1];
      const outputPath = arguments_[arguments_.indexOf("--output") + 1];
      if (!inputPath || !outputPath) throw new Error("Invalid MuScriptor arguments");
      await writeFile(
        outputPath,
        basename(inputPath) === "vocals.wav"
          ? vocalStemMidi()
          : midiWithTrack("acoustic guitar", 24, 60, 0.5),
      );
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

describe("mergeLeadVocalMidi", () => {
  it("preserves backing tracks and collapses all vocal-stem tracks into Choir Aahs", () => {
    const baseBytes = midiWithTrack("voice", 52, 60, 0.5);
    const mergedBytes = mergeLeadVocalMidi(baseBytes, midiWithTrack("source", 0, 67, 2.25), {
      velocity: 127,
      accompanimentVolume: 127,
    });
    const merged = new Midi(mergedBytes);

    const backing = merged.tracks.find((track) => track.name === "voice");
    const lead = merged.tracks.find((track) => track.name === "lead vocal");
    expect(backing?.instrument.number).toBe(52);
    expect(lead?.instrument.number).toBe(52);
    expect(lead?.notes).toHaveLength(1);
    expect(lead?.notes[0]).toMatchObject({ midi: 67, velocity: 1 });
    expect(lead?.notes[0]?.time).toBeCloseTo(2.25, 2);
    const original = parseMidi(baseBytes);
    const rawMerged = parseMidi(mergedBytes);
    expect(rawMerged.header).toMatchObject({
      format: original.header.format,
      ticksPerBeat: "ticksPerBeat" in original.header ? original.header.ticksPerBeat : undefined,
      numTracks: original.header.numTracks + 1,
    });
    expect(rawMerged.tracks.slice(0, original.tracks.length)).toEqual(original.tracks);
  });

  it("maps vocal seconds through tempo changes in the base MIDI", () => {
    const tempoTrack: MidiEvent[] = [
      { deltaTime: 0, type: "setTempo", microsecondsPerBeat: 500_000, meta: true },
      { deltaTime: 960, type: "setTempo", microsecondsPerBeat: 1_000_000, meta: true },
      { deltaTime: 0, type: "endOfTrack", meta: true },
    ];
    const base: MidiData = {
      header: { format: 1, numTracks: 1, ticksPerBeat: 960 },
      tracks: [tempoTrack],
    };
    const merged = parseMidi(
      mergeLeadVocalMidi(
        Buffer.from(writeMidi(base)),
        midiWithTrack("source", 0, 67, 1.5),
      ),
    );
    const lead = merged.tracks.at(-1) ?? [];
    let absoluteTick = 0;
    const noteOn = lead.find((event) => {
      absoluteTick += event.deltaTime;
      return event.type === "noteOn";
    });

    expect(noteOn?.type).toBe("noteOn");
    expect(absoluteTick).toBe(1920);
  });

  it("fails instead of changing an occupied channel instrument", () => {
    const tracks: MidiEvent[][] = Array.from({ length: 16 }, (_, channel) => [
      { deltaTime: 0, type: "programChange", channel, programNumber: channel },
      { deltaTime: 0, type: "endOfTrack", meta: true },
    ]);
    const base: MidiData = {
      header: { format: 1, numTracks: tracks.length, ticksPerBeat: 480 },
      tracks,
    };

    expect(() =>
      mergeLeadVocalMidi(
        Buffer.from(writeMidi(base)),
        midiWithTrack("source", 0, 67, 1),
      ),
    ).toThrow("No MIDI channel is available for lead vocals");
  });

  it("safely reuses an existing voice channel when all channels are occupied", () => {
    const tracks: MidiEvent[][] = Array.from({ length: 16 }, (_, channel) => [
      {
        deltaTime: 0,
        type: "programChange",
        channel,
        programNumber: channel === 3 ? 52 : channel,
      },
      { deltaTime: 0, type: "endOfTrack", meta: true },
    ]);
    const base: MidiData = {
      header: { format: 1, numTracks: tracks.length, ticksPerBeat: 480 },
      tracks,
    };

    const merged = parseMidi(
      mergeLeadVocalMidi(
        Buffer.from(writeMidi(base)),
        midiWithTrack("source", 0, 67, 1),
      ),
    );
    const lead = merged.tracks.at(-1) ?? [];
    expect(lead).toContainEqual(
      expect.objectContaining({ type: "programChange", channel: 3, programNumber: 52 }),
    );
  });
});

describe("LeadVocalService", () => {
  it("separates first, transcribes both stems, collapses vocal tracks, and cleans work files", async () => {
    const outputDirectory = await temporaryDirectory();
    await mkdir(join(outputDirectory, ".results"));
    const audioPath = join(outputDirectory, "song.flac");
    const midiPath = join(outputDirectory, "song.mid");
    await writeFile(audioPath, "audio");
    const runner = new PipelineRunner();

    const noteCount = await new LeadVocalService(config(outputDirectory), runner).enhance(
      audioPath,
      midiPath,
      { velocity: 127, accompanimentVolume: 89 },
      transcription,
    );

    expect(noteCount).toBe(2);
    expect(runner.calls.map(({ command }) => command)).toEqual(["demucs", "muscriptor", "muscriptor"]);
    expect(runner.calls[0]?.arguments_).toContain("--two-stems=vocals");
    expect(runner.calls[0]?.arguments_).toEqual(expect.arrayContaining(["--device", "xpu"]));
    expect(runner.calls[1]?.arguments_.at(1)).toMatch(/vocals\.wav$/);
    expect(runner.calls[1]?.arguments_).toEqual(expect.arrayContaining(["--instruments", "voice"]));
    expect(runner.calls[1]?.arguments_).toEqual(expect.arrayContaining([
      "--empty-output-retries", "3",
      "--empty-output-temperature", "0.6",
      "--empty-output-cfg-coef", "1.75",
      "--empty-output-beam-size", "3",
    ]));
    expect(runner.calls[2]?.arguments_.at(1)).toMatch(/no_vocals\.wav$/);
    expect(runner.calls[2]?.arguments_).toEqual(expect.arrayContaining(["--instruments", "guitar"]));
    expect(runner.calls[2]?.arguments_).toEqual(expect.arrayContaining([
      "--cfg-coef", "1",
      "--beam-size", "1",
    ]));
    expect(runner.calls[2]?.arguments_).not.toContain("--empty-output-retries");
    const output = new Midi(await readFile(midiPath));
    const backing = output.tracks.find((track) => track.name === "acoustic guitar");
    const lead = output.tracks.find((track) => track.name === "lead vocal");
    expect(backing?.controlChanges[7]?.[0]?.value).toBeCloseTo(89 / 127, 3);
    expect(output.tracks.filter((track) => track.notes.length === 0)).toHaveLength(0);
    expect(lead?.notes[0]?.velocity).toBe(1);
    expect(lead?.notes.map((note) => note.midi)).toEqual([64, 67]);
    expect(lead?.controlChanges[7]?.[0]?.value).toBe(1);
    expect(lead?.controlChanges[11]?.[0]?.value).toBe(1);
    expect(await readdir(join(outputDirectory, ".lead-vocal"))).toEqual([]);
  });

  it("rejects an incomplete Demucs result before running MuScriptor", async () => {
    const outputDirectory = await temporaryDirectory();
    const audioPath = join(outputDirectory, "song.flac");
    const midiPath = join(outputDirectory, "song.mid");
    await writeFile(audioPath, "audio");
    const runner = new PipelineRunner(true);

    await expect(
      new LeadVocalService(config(outputDirectory), runner).enhance(
        audioPath,
        midiPath,
        { velocity: 127, accompanimentVolume: 89 },
        transcription,
      ),
    ).rejects.toMatchObject({ code: "ACCOMPANIMENT_STEM_MISSING" });
    expect(runner.calls.map(({ command }) => command)).toEqual(["demucs"]);
    expect(await readdir(join(outputDirectory, ".lead-vocal"))).toEqual([]);
  });
});
