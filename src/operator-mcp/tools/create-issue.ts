import { z } from "zod";

import { defineOperatorTool } from "../tool";

export const createIssue = defineOperatorTool({
  name: "create_issue",
  description: "Create an issue with a title and body in an onboarded repository (its configured id or owner/name address) and enroll it in Conveyor, so it enters the pipeline at the start stage. Answers right after the issue is created; the repository is read in the background. Pass an optional idempotencyKey: a retry with the same key and repository returns the first call's issue instead of creating another. Fails, creating nothing, for a repository that is not onboarded or an empty title.",
  inputSchema: z.object({
    repository: z.string().min(1),
    title: z.string().trim().min(1),
    body: z.string().max(65_000).default(""),
    idempotencyKey: z.string().min(1).max(200).optional(),
  }).strict(),
  handler: ({ input, facade }) => facade.createIssue(input),
});
