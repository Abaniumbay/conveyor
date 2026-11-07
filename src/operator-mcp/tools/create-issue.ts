import { z } from "zod";

import { defineOperatorTool } from "../tool";

export const createIssue = defineOperatorTool({
  name: "create_issue",
  description: "Create an issue with a title and body in an onboarded repository (its configured id or owner/name address) and enroll it in Conveyor, so it enters the pipeline at the start stage. Fails, creating nothing, for a repository that is not onboarded or an empty title.",
  inputSchema: z.object({
    repository: z.string().min(1),
    title: z.string().trim().min(1),
    body: z.string().max(65_000).default(""),
  }).strict(),
  handler: ({ input, facade }) => facade.createIssue(input),
});
