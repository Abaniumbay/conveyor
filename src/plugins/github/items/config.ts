import { z } from "zod";

/** A GitHub item source (`providers.items.<name>` with `type: github`). */
export const githubSourceSchema = z
  .object({
    type: z.literal("github"),
    webhookPath: z.string().startsWith("/").default("/hooks/github"),
    autoConfigureWebhook: z.boolean().default(false),
    /** Verifies webhook deliveries; CONVEYOR_GITHUB_WEBHOOK_SECRET is the fallback. */
    webhookSecret: z.string().min(1).optional(),
  })
  .strict();

export type GitHubSourceConfig = z.output<typeof githubSourceSchema>;
