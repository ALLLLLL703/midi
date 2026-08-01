import { delimiter, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../src/config/runtime-config.js";

describe("loadRuntimeConfig", () => {
  it("uses secure defaults relative to the working directory", () => {
    const config = loadRuntimeConfig({}, "/workspace");

    expect(config).toMatchObject({
      muscriptorCommand: "muscriptor",
      demucsCommand: "demucs",
      demucsDevice: "auto",
      basicPitchCommand: "basic-pitch",
      allowedInputDirectories: ["/workspace"],
      outputDirectory: "/workspace/.midi-output",
      downloadMaxBytes: 200 * 1024 * 1024,
      downloadTimeoutMs: 300_000,
    });
  });

  it("resolves multiple configured input roots", () => {
    const config = loadRuntimeConfig(
      { MIDI_MCP_ALLOWED_INPUT_DIRS: ["audio", "/shared/music"].join(delimiter) },
      "/workspace",
    );

    expect(config.allowedInputDirectories).toEqual([
      resolve("/workspace/audio"),
      resolve("/shared/music"),
    ]);
  });

  it("rejects invalid numeric limits", () => {
    expect(() =>
      loadRuntimeConfig({ MIDI_MCP_DOWNLOAD_MAX_BYTES: "0" }, "/workspace"),
    ).toThrow();
  });
});
