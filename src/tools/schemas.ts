import { z } from "zod";

const deviceSchema = z.string().regex(/^(auto|cpu|cuda(?::\d+)?|mps|xpu)$/);

function transcriptionFields(defaults: {
  readonly model: "medium" | "large";
  readonly device: "auto" | "xpu";
  readonly dtype?: "float16";
  readonly cfgCoef: number;
  readonly beamSize: number;
}) {
  return {
    source: z.string().min(1).describe("Allowed local path or public HTTPS audio URL."),
    outputFileName: z.string().min(1).max(255).optional().describe(
      "Optional output basename. A .mid extension is added automatically; existing files are never overwritten.",
    ),
    model: z.enum(["small", "medium", "large"]).default(defaults.model),
    device: deviceSchema.default(defaults.device),
    dtype: defaults.dtype
      ? z.enum(["float32", "float16", "bfloat16"]).default(defaults.dtype)
      : z.enum(["float32", "float16", "bfloat16"]).optional(),
    instruments: z.array(z.string().min(1)).min(1).optional(),
    sampling: z.boolean().default(false),
    temperature: z.number().positive().default(1),
    cfgCoef: z.number().nonnegative().default(defaults.cfgCoef),
    batchSize: z.number().int().positive().optional(),
    strictEos: z.boolean().default(false),
    beamSize: z.number().int().min(1).default(defaults.beamSize),
    preludeForcing: z.boolean().default(true),
  };
}

export const instrumentalAudioToMidiInputSchema = z.object(transcriptionFields({
  model: "medium",
  device: "auto",
  cfgCoef: 1,
  beamSize: 1,
}));

export const vocalAudioToMidiInputSchema = z.object({
  ...transcriptionFields({
    model: "large",
    device: "xpu",
    dtype: "float16",
    cfgCoef: 1,
    beamSize: 1,
  }),
  emptyOutputRetries: z.number().int().min(0).default(3),
  emptyOutputTemperature: z.number().positive().default(0.6),
  emptyOutputCfgCoef: z.number().positive().default(1.75),
  emptyOutputBeamSize: z.number().int().min(1).default(3),
  leadVocalVelocity: z.number().int().min(1).max(127).default(127).describe(
    "Fixed MIDI velocity for lead-vocal notes.",
  ),
  leadVocalAccompanimentVolume: z.number().int().min(0).max(127).default(89).describe(
    "MIDI CC7 volume applied to non-drum accompaniment channels.",
  ),
});

export type InstrumentalAudioToMidiInput = z.infer<typeof instrumentalAudioToMidiInputSchema>;
export type VocalAudioToMidiInput = z.infer<typeof vocalAudioToMidiInputSchema>;

interface CompatibleTranscriptionInput {
  readonly preludeForcing: boolean;
  readonly batchSize?: number | undefined;
}

/** Validates option relationships that must not wrap the public Zod object schema. */
export function assertCompatibleTranscriptionOptions(input: CompatibleTranscriptionInput): void {
  if (input.preludeForcing && input.batchSize !== undefined && input.batchSize !== 1) {
    throw new Error("batchSize greater than 1 requires preludeForcing=false.");
  }
}
