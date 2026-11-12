import { z } from "zod";

import { identifierSchema } from "../../../config/schema";

const triggerSchema = z.object({
  label: identifierSchema,
  workflow: z.string().regex(/^[\w.-]+\.ya?ml$/, "must be a workflow file name"),
  check: identifierSchema,
  replaces: z.array(identifierSchema).default([]),
}).strict();

/** A GitHub Actions CI provider (`providers.ci.<name>` with `type: github-actions`). */
export const githubActionsSchema = z.object({
  type: z.literal("github-actions"),
  triggers: z.array(triggerSchema).default([]),
}).strict();
