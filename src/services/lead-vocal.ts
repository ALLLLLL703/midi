import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ToneMidi from "@tonejs/midi";
import { parseMidi, writeMidi, type MidiData, type MidiEvent } from "midi-file";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { AppError } from "../util/app-error.js";
import { buildTranscriptionArguments, type TranscriptionOptions } from "./muscriptor.js";
import type { ProcessRunner } from "./process-runner.js";
import { ensurePrivateSubdirectory } from "../util/path-security.js";

const CHOIR_AAHS_PROGRAM = 52;
const { Midi } = ToneMidi;

export interface LeadVocalHealth {
  readonly ok: boolean;
  readonly detail: string;
}

export interface LeadVocalProcessor {
  enhance(
    audioPath: string,
    midiPath: string,
    mix: LeadVocalMix,
    transcription: TranscriptionOptions,
    signal?: AbortSignal,
  ): Promise<number>;
  checkHealth(): Promise<LeadVocalHealth>;
}

export interface LeadVocalMix {
  readonly velocity: number;
  readonly accompanimentVolume: number;
}

async function findGeneratedFile(
  directory: string,
  predicate: (name: string) => boolean,
): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findGeneratedFile(path, predicate);
      if (nested) return nested;
    } else if (entry.isFile() && predicate(entry.name)) {
      return path;
    }
  }
  return undefined;
}

interface TempoPoint {
  readonly tick: number;
  readonly seconds: number;
  readonly microsecondsPerBeat: number;
}

function baseTempoMap(midi: MidiData): { ppq: number; points: TempoPoint[] } {
  if (!("ticksPerBeat" in midi.header)) {
    throw new AppError("UNSUPPORTED_MIDI_TIMING", "SMPTE-timed MIDI cannot be enhanced.");
  }
  const ppq = midi.header.ticksPerBeat;
  const events: { tick: number; microsecondsPerBeat: number }[] = [];
  for (const track of midi.tracks) {
    let tick = 0;
    for (const event of track) {
      tick += event.deltaTime;
      if (event.type === "setTempo") {
        events.push({ tick, microsecondsPerBeat: event.microsecondsPerBeat });
      }
    }
  }
  events.sort((left, right) => left.tick - right.tick);
  const points: TempoPoint[] = [{ tick: 0, seconds: 0, microsecondsPerBeat: 500_000 }];
  for (const event of events) {
    const previous = points.at(-1);
    if (!previous) continue;
    const seconds = previous.seconds
      + ((event.tick - previous.tick) * previous.microsecondsPerBeat) / (ppq * 1_000_000);
    const point = { tick: event.tick, seconds, microsecondsPerBeat: event.microsecondsPerBeat };
    if (event.tick === previous.tick) points[points.length - 1] = point;
    else points.push(point);
  }
  return { ppq, points };
}

function secondsToTicks(seconds: number, ppq: number, points: readonly TempoPoint[]): number {
  let point = points[0];
  for (const candidate of points) {
    if (candidate.seconds > seconds) break;
    point = candidate;
  }
  if (!point) return 0;
  return Math.max(
    0,
    Math.round(point.tick + ((seconds - point.seconds) * ppq * 1_000_000) / point.microsecondsPerBeat),
  );
}

interface MelodyChannel {
  readonly channel: number;
  readonly program: number;
}

function availableMelodyChannel(midi: MidiData): MelodyChannel {
  const used = new Set<number>();
  let existingVoice: MelodyChannel | undefined;
  for (const track of midi.tracks) {
    for (const event of track) {
      if ("channel" in event) used.add(event.channel);
      if (
        event.type === "programChange"
        && (event.programNumber === 52 || event.programNumber === 53)
      ) {
        existingVoice = { channel: event.channel, program: event.programNumber };
      }
    }
  }
  const channel = Array.from({ length: 16 }, (_, candidate) => candidate).find(
    (candidate) => candidate !== 9 && !used.has(candidate),
  );
  if (channel !== undefined) {
    return { channel, program: CHOIR_AAHS_PROGRAM };
  }
  if (!existingVoice) {
    throw new AppError("MIDI_CHANNELS_EXHAUSTED", "No MIDI channel is available for lead vocals.");
  }
  return existingVoice;
}

/** Collapses every detected vocal-stem track into one time-aligned lead-vocal track. */
export function mergeLeadVocalMidi(
  baseBytes: Buffer,
  vocalBytes: Buffer,
  mix: LeadVocalMix = { velocity: 127, accompanimentVolume: 89 },
): Buffer {
  const base = parseMidi(baseBytes);
  const vocal = new Midi(vocalBytes);
  const melodyChannel = availableMelodyChannel(base);
  const { channel } = melodyChannel;
  const { ppq, points } = baseTempoMap(base);
  const timedEvents: { tick: number; order: number; event: MidiEvent }[] = [];
  let noteCount = 0;
  for (const sourceTrack of vocal.tracks) {
    for (const note of sourceTrack.notes) {
      const startTick = secondsToTicks(note.time, ppq, points);
      const endTick = Math.max(startTick + 1, secondsToTicks(note.time + note.duration, ppq, points));
      timedEvents.push({
        tick: startTick,
        order: 1,
        event: { deltaTime: 0, type: "noteOn", channel, noteNumber: note.midi, velocity: mix.velocity },
      });
      timedEvents.push({
        tick: endTick,
        order: 0,
        event: { deltaTime: 0, type: "noteOff", channel, noteNumber: note.midi, velocity: 0 },
      });
      noteCount += 1;
    }
  }
  if (noteCount === 0) {
    throw new AppError("LEAD_VOCAL_EMPTY", "No lead-vocal notes were detected.");
  }
  timedEvents.sort((left, right) => left.tick - right.tick || left.order - right.order);
  const target: MidiEvent[] = [
    { deltaTime: 0, type: "trackName", text: "lead vocal", meta: true },
    { deltaTime: 0, type: "programChange", channel, programNumber: melodyChannel.program },
    { deltaTime: 0, type: "controller", channel, controllerType: 7, value: 127 },
    { deltaTime: 0, type: "controller", channel, controllerType: 11, value: 127 },
  ];
  let previousTick = 0;
  for (const timed of timedEvents) {
    target.push({ ...timed.event, deltaTime: timed.tick - previousTick });
    previousTick = timed.tick;
  }
  target.push({ deltaTime: 0, type: "endOfTrack", meta: true });
  if (mix.accompanimentVolume < 127) {
    const channels = new Set(
      base.tracks.flatMap((track) => track.flatMap((event) => (
        "channel" in event && event.channel !== 9 && event.channel !== channel
          ? [event.channel]
          : []
      ))),
    );
    for (const accompanimentChannel of channels) {
      const track = base.tracks.find((candidate) => candidate.some(
        (event) => event.type === "programChange" && event.channel === accompanimentChannel,
      ));
      if (!track) continue;
      const programIndex = track.findIndex(
        (event) => event.type === "programChange" && event.channel === accompanimentChannel,
      );
      track.splice(programIndex + 1, 0, {
        deltaTime: 0,
        type: "controller",
        channel: accompanimentChannel,
        controllerType: 7,
        value: mix.accompanimentVolume,
      });
    }
  }
  base.tracks.push(target);
  const output = Buffer.from(writeMidi(base));
  parseMidi(output);
  return output;
}

/** Separates stems, transcribes both with MuScriptor, and merges detected vocal notes. */
export class LeadVocalService implements LeadVocalProcessor {
  public constructor(
    private readonly config: RuntimeConfig,
    private readonly runner: ProcessRunner,
  ) {}

  public async enhance(
    audioPath: string,
    midiPath: string,
    mix: LeadVocalMix,
    transcription: TranscriptionOptions,
    signal?: AbortSignal,
  ): Promise<number> {
    const workRoot = await ensurePrivateSubdirectory(this.config.outputDirectory, ".lead-vocal");
    const workDirectory = await mkdtemp(join(workRoot, "job-"));
    try {
      if (signal?.aborted) throw new AppError("CANCELLED", "Lead-vocal processing was cancelled.");
      console.error(JSON.stringify({ event: "lead_vocal.separation_started" }));
      const separation = await this.runner.run(
        this.config.demucsCommand,
        [
          "--two-stems=vocals",
          "--out",
          workDirectory,
          ...(this.config.demucsDevice === "auto" ? [] : ["--device", this.config.demucsDevice]),
          audioPath,
        ],
        this.config.processTimeoutMs,
        signal,
      );
      if (separation.exitCode !== 0) {
        throw new AppError(
          "DEMUCS_FAILED",
          separation.stderr.trim() || `Demucs exited with code ${separation.exitCode}.`,
        );
      }
      const vocalsPath = await findGeneratedFile(
        workDirectory,
        (name) => name.toLowerCase() === "vocals.wav",
      );
      if (!vocalsPath) {
        throw new AppError("VOCAL_STEM_MISSING", "Demucs completed without creating vocals.wav.");
      }
      const accompanimentPath = await findGeneratedFile(
        workDirectory,
        (name) => name.toLowerCase() === "no_vocals.wav",
      );
      if (!accompanimentPath) {
        throw new AppError(
          "ACCOMPANIMENT_STEM_MISSING",
          "Demucs completed without creating no_vocals.wav.",
        );
      }
      if (signal?.aborted) throw new AppError("CANCELLED", "Lead-vocal processing was cancelled.");

      const accompanimentMidiPath = join(workDirectory, "accompaniment.mid");
      console.error(JSON.stringify({ event: "lead_vocal.accompaniment_transcription_started" }));
      await this.transcribeStem(
        accompanimentPath,
        accompanimentMidiPath,
        transcription,
        signal,
      );
      const vocalMidiPath = join(workDirectory, "vocals.mid");
      console.error(JSON.stringify({ event: "lead_vocal.vocal_transcription_started" }));
      await this.transcribeStem(
        vocalsPath,
        vocalMidiPath,
        { ...transcription, instruments: undefined },
        signal,
      );
      if (signal?.aborted) throw new AppError("CANCELLED", "Lead-vocal processing was cancelled.");

      const merged = mergeLeadVocalMidi(
        await readFile(accompanimentMidiPath),
        await readFile(vocalMidiPath),
        mix,
      );
      const parsed = new Midi(merged);
      const leadTrack = parsed.tracks.find((track) => track.name === "lead vocal");
      await writeFile(midiPath, merged, { flag: "wx", mode: 0o600 });
      console.error(JSON.stringify({ event: "lead_vocal.completed", notes: leadTrack?.notes.length ?? 0 }));
      return leadTrack?.notes.length ?? 0;
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }

  private async transcribeStem(
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
    try {
      const midi = parseMidi(await readFile(midiPath));
      if (midi.tracks.length === 0) throw new Error("MIDI contains no tracks");
    } catch (error) {
      throw new AppError("INVALID_MIDI_OUTPUT", "MuScriptor produced an invalid stem MIDI.", {
        cause: error,
      });
    }
  }

  public async checkHealth(): Promise<LeadVocalHealth> {
    const demucs = await this.runner.run(this.config.demucsCommand, ["--help"], 30_000);
    return demucs.exitCode === 0
      ? { ok: true, detail: "Demucs is available; vocal stems use MuScriptor." }
      : { ok: false, detail: "Demucs is unavailable." };
  }
}
