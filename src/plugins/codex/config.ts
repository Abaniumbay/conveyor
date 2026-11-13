import { z } from "zod";

import { controlPlaneHostsSchema, harnessSettingsSchema } from "../../config/schema";

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

const CODEX_CONFIG_KEY = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
/** Codex settings Conveyor derives from the agent's other fields; an agent's settings must not override them. */
const CONVEYOR_CODEX_KEYS = /^(mcp_servers|sandbox_mode|sandbox_workspace_write|approvals_reviewer|model_reasoning_effort|web_search)(\.|$)/;

/** A Codex agent's `harnessSettings`: extra Codex settings, passed as `-c key=value`. */
export const codexAgentSettingsSchema = harnessSettingsSchema.superRefine((settings, context) => {
  for (const key of Object.keys(settings)) {
    if (!CODEX_CONFIG_KEY.test(key)) {
      context.addIssue({ code: "custom", path: [key], message: "must be a dotted Codex config key" });
    } else if (CONVEYOR_CODEX_KEYS.test(key)) {
      context.addIssue({ code: "custom", path: [key], message: "is set by Conveyor from the agent's other settings" });
    }
  }
});
