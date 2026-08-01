import { z } from "zod";

const deviceSchema = z.string().regex(/^(auto|cpu|cuda(?::\d+)?|mps)$/);

export const audioToMidiInputSchema = z.object({
  source: z.string().min(1).describe("Allowed local path or public HTTPS audio URL."),
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
}).superRefine((input, context) => {
  if (input.preludeForcing && input.batchSize !== undefined && input.batchSize !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["batchSize"],
      message: "batchSize greater than 1 requires preludeForcing=false.",
    });
  }
});

export type AudioToMidiInput = z.infer<typeof audioToMidiInputSchema>;
