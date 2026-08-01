const messages = {
  serverStarted: "midi MCP server started",
  invalidInput: "The input is invalid.",
  transcriptionFailed: "MuScriptor transcription failed.",
  healthCheckFailed: "MuScriptor health check failed.",
  unexpectedError: "An unexpected error occurred.",
  audioToMidiDescription:
    "Transcribe a local or public HTTPS audio file to a multi-instrument MIDI file with MuScriptor.",
  checkModelDescription:
    "Check whether MuScriptor and the writable output directory are ready without loading model weights.",
} as const;

export type MessageKey = keyof typeof messages;

/** Resolves stable user-facing message keys. */
export function translate(key: MessageKey): string {
  return messages[key];
}
