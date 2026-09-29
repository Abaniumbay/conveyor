import { z } from "zod";

const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0),
    cachedTokens: z.number().int().nonnegative().default(0),
  })
  .strict();

const costSchema = z
  .object({
    amount: z.number().nonnegative(),
    currency: z.string().trim().length(3).default("USD"),
    source: z.enum(["reported", "calculated", "unavailable"]),
  })
  .strict();

const artifactSchema = z
  .object({
    name: z.string().trim().min(1),
    path: z.string().min(1),
    mediaType: z.string().min(1).optional(),
  })
  .strict();

export const producerResultSchema = z
  .object({
    version: z.literal(1),
    outcome: z.enum(["success", "failure"]),
    status: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    reason: z.string().trim().min(1).nullable().default(null),
    metrics: z.record(z.string(), z.unknown()).default({}),
    sessionId: z.string().min(1).nullable().optional(),
    usage: usageSchema.optional(),
    cost: costSchema.optional(),
    artifacts: z.array(artifactSchema).default([]),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.outcome === "failure" && result.reason === null) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "a failed result requires a reason",
      });
    }
  });

export type ProducerResult = z.output<typeof producerResultSchema>;
export type Artifact = z.output<typeof artifactSchema>;

export interface RunEnvelope {
  stageResult: {
    outcome: ProducerResult["outcome"];
    status: string;
    summary: string;
    reason: string | null;
    metrics: Record<string, unknown>;
  };
  sessionId: string | null;
  usage: z.output<typeof usageSchema>;
  cost: z.output<typeof costSchema>;
  durationMs: number;
  exitCode: number;
  artifacts: Artifact[];
  stderr: string;
}

export const EMPTY_USAGE: RunEnvelope["usage"] = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
};

export const UNAVAILABLE_COST: RunEnvelope["cost"] = {
  amount: 0,
  currency: "USD",
  source: "unavailable",
};
