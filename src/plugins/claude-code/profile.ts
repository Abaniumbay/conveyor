import type { HarnessProfile } from "../../harness/types";
import { CLAUDE_CONTROL_PLANE_HOSTS } from "./launch";

/**
 * Claude Code derives its sandbox from the agent's access, may run without a shell, cannot run
 * confined agents, and needs the network for a workspace-write agent. Its login and sessions live
 * in the runner's `configDir`, mounted writable for the run.
 */
export const claudeCodeProfile: HarnessProfile = {
  name: "Claude Code",
  controlPlaneHosts: CLAUDE_CONTROL_PLANE_HOSTS,
  runVariables: ["CLAUDE_CONFIG_DIR"],
  configDirectoryVariable: "CLAUDE_CONFIG_DIR",
  sandbox: "access",
  optionalShell: true,
  confinedAccess: false,
  workspaceWriteNeedsNetwork: true,
  agentEgress: true,
};
