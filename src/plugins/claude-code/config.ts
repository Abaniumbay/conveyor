import { z } from "zod";

import { absolutePathSchema, controlPlaneHostsSchema } from "../../config/schema";
import { resolveFilesystemPath } from "../../core/paths";

/** A Claude Code runner (`harnesses.<name>` with `type: claude-code`). */
export const claudeCodeRunnerSchema = z
  .object({
    type: z.literal("claude-code"),
    command: z.string().min(1).default("claude"),
    /** Claude Code's config directory (login and sessions); defaults to ~/.claude, the service user's login. */
    configDir: absolutePathSchema.transform(resolveFilesystemPath).optional(),
    /** Hosts the Claude Code process itself may reach when egress is enforced (default: Anthropic). */
    controlPlaneHosts: controlPlaneHostsSchema,
  })
  .strict();
