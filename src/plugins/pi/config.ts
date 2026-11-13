import { z } from "zod";

import { absolutePathSchema, controlPlaneHostsSchema } from "../../config/schema";
import { resolveFilesystemPath } from "../../core/paths";

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Variables a runner may not hand to pi as credentials: source-provider and Git credentials (which
 * no agent process may hold), Conveyor's own, pi's own and the ones Conveyor sets for every run.
 */
const RESERVED_VARIABLE = /^(GH_|GITHUB_|GIT_|CONVEYOR_|PI_)|^(SSH_AUTH_SOCK|HOME|PATH|SHELL|TMPDIR|USER|LOGNAME)$/;

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
     * Service environment variables the pi process receives for its own provider login, such as an API
     * key; the agent's commands never receive them.
     */
    credentialVariables: z
      .array(
        z.string()
          .regex(VARIABLE_NAME, "must be an environment variable name")
          .refine((name) => !RESERVED_VARIABLE.test(name), "is reserved: Conveyor never hands it to an agent harness as a credential"),
      )
      .default([]),
    /** Hosts the pi process itself may reach once egress is supported for pi; not used yet. */
    controlPlaneHosts: controlPlaneHostsSchema,
  })
  .strict();

export type PiRunnerConfig = z.output<typeof piRunnerSchema>;
