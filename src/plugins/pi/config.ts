import { z } from "zod";

import { absolutePathSchema, controlPlaneHostsSchema } from "../../config/schema";
import { resolveFilesystemPath } from "../../core/paths";
import { reservedVariable } from "../../isolation/run-environment";
import { PI_AGENT_DIRECTORY } from "./agent-directory";

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A pi runner (`harnesses.<name>` with `type: pi`). */
export const piRunnerSchema = z
  .object({
    type: z.literal("pi"),
    command: z.string().min(1).default("pi"),
    /** pi's agent directory (login and settings); defaults to ~/.pi/agent, the service user's. Runs get a private copy of its login. */
    configDir: absolutePathSchema.transform(resolveFilesystemPath).optional(),
    /** The provider pi looks the agent's model up in (`--provider`); absent: pi chooses. */
    provider: z.string().trim().min(1).optional(),
    /**
     * Deprecated: service environment variables the pi process receives, which its commands never do.
     * The harness entry's `settings.environment` does the same.
     */
    credentialVariables: z
      .array(
        z.string()
          .regex(VARIABLE_NAME, "must be an environment variable name")
          .refine((name) => !reservedVariable(name) && name !== PI_AGENT_DIRECTORY, "is set by Conveyor or pi for every run"),
      )
      .default([]),
    /**
     * Hosts the pi process itself may reach when egress is enforced (default: the hosts of `provider`,
     * when pi's provider is one Conveyor knows); a runner used under egress with neither is refused.
     */
    controlPlaneHosts: controlPlaneHostsSchema,
  })
  .strict();

export type PiRunnerConfig = z.output<typeof piRunnerSchema>;
