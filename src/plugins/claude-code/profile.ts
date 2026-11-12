import type { HarnessProfile } from "../../harness/types";
import { CLAUDE_CONTROL_PLANE_HOSTS } from "../../isolation/run-network";

/**
 * Claude Code derives its sandbox from the agent's access, may run without a shell and takes no extra
 * settings. Its login and sessions live in the runner's `configDir`, mounted writable for the run.
 */
export const claudeCodeProfile: HarnessProfile = {
  controlPlaneHosts: CLAUDE_CONTROL_PLANE_HOSTS,
  controlPlaneEnvironment: ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  configDirectoryVariable: "CLAUDE_CONFIG_DIR",
  sandbox: "access",
  optionalShell: true,
  extraSettings: false,
};
