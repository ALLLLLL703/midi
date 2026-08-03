import { z } from "zod";

const deviceSchema = z.string().regex(/^(auto|cpu|cuda(?::\d+)?|mps|xpu)$/);

export const audioToMidiInputSchema = z.object({
  source: z.string().min(1).describe("Allowed local path or public HTTPS audio URL."),
  outputFileName: z.string().min(1).max(255).optional().describe(
    "Optional output basename. A .mid extension is added automatically; existing files are never overwritten.",
  ),
  model: z.enum(["small", "medium", "large"]).default("medium"),
  device: deviceSchema.default("auto"),
  dtype: z.enum(["float32", "float16", "bfloat16"]).optional(),
  instruments: z.array(z.string().min(1)).min(1).optional(),
  sampling: z.boolean().default(false),
  temperature: z.number().positive().default(1),
  cfgCoef: z.number().nonnegative().default(1),
  batchSize: z.number().int().positive().optional(),
  strictEos: z.boolean().default(false),
  beamSize: z.number().int().min(1).default(1),
  preludeForcing: z.boolean().default(true),
  includeLeadVocal: z.boolean().default(false).describe(
    "Separate vocals with Demucs, transcribe both stems with MuScriptor, and add a collapsed lead-vocal track.",
  ),
  leadVocalVelocity: z.number().int().min(1).max(127).default(127).describe(
    "Fixed MIDI velocity for lead-vocal notes.",
  ),
  leadVocalAccompanimentVolume: z.number().int().min(0).max(127).default(89).describe(
    "MIDI CC7 volume applied to non-drum accompaniment channels when lead vocals are enabled.",
  ),
});

export type AudioToMidiInput = z.infer<typeof audioToMidiInputSchema>;

/** Validates option relationships that must not wrap the public Zod object schema. */
export function assertCompatibleTranscriptionOptions(input: AudioToMidiInput): void {
  if (input.preludeForcing && input.batchSize !== undefined && input.batchSize !== 1) {
    throw new Error("batchSize greater than 1 requires preludeForcing=false.");
  }
}
