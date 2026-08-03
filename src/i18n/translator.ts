const messages = {
  serverStarted: "midi MCP server started",
  invalidInput: "The input is invalid.",
  transcriptionFailed: "MuScriptor transcription failed.",
  healthCheckFailed: "MuScriptor health check failed.",
  unexpectedError: "An unexpected error occurred.",
  vocalAudioToMidiDescription:
    "Transcribe music with vocals to a complete MIDI: separate vocals with Demucs, transcribe both stems, and merge a dedicated lead-vocal track.",
  instrumentalAudioToMidiDescription:
    "Transcribe instrumental or other non-vocal audio directly to multi-instrument MIDI with MuScriptor.",
  checkModelDescription:
    "Check whether MuScriptor and the writable output directory are ready without loading model weights.",
} as const;

export type MessageKey = keyof typeof messages;

/** Resolves stable user-facing message keys. */
export function translate(key: MessageKey): string {
  return messages[key];
}
