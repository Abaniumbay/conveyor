import { readFile } from "node:fs/promises";
import { z } from "zod";

import type { RunMcpContext } from "./server";

const contextSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  stageId: z.string().min(1),
  repository: z.object({
    id: z.string().min(1),
    address: z.string().min(1),
    baseBranch: z.string().min(1),
  }),
  issue: z.object({
    id: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string(),
    labels: z.array(z.string()),
    url: z.string().url(),
  }),
  workspace: z.object({ path: z.string(), branch: z.string() }).nullable(),
  delivery: z.object({ pullRequest: z.unknown().nullable(), checks: z.array(z.unknown()) }),
  sourceGuidance: z.string(),
  control: z.object({ url: z.string().url(), token: z.string().min(1) }),
  allowedTools: z.array(z.string()),
});

export async function loadRunMcpContext(filename: string): Promise<RunMcpContext> {
  const text = await readFile(filename, "utf8");
  let input: unknown;
  try {
    input = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`invalid MCP context JSON in ${filename}`, { cause: error });
  }
  return contextSchema.parse(input);
}
