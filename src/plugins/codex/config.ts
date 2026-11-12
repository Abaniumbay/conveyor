import { z } from "zod";

import { controlPlaneHostsSchema } from "../../config/schema";

/** A Codex runner (`harnesses.<name>` with `type: codex`). */
export const codexRunnerSchema = z
  .object({
    type: z.literal("codex"),
    command: z.string().min(1).default("codex"),
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
    automaticApprovals: z.boolean().default(true),
    /** Hosts the Codex process itself may reach when egress is enforced (default: ChatGPT and OpenAI). */
    controlPlaneHosts: controlPlaneHostsSchema,
  })
  .strict();
