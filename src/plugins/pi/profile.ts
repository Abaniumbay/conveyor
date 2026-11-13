import type { HarnessProfile } from "../../harness/types";
import { PI_AGENT_DIRECTORY } from "./agent-directory";

/**
 * pi derives its sandbox from the agent's access, may run without a shell, cannot run confined
 * agents, and needs the network for a workspace-write agent. Conveyor's empty-root sandbox is its
 * only sandbox. Its login stays in its agent directory (the runner's `configDir`), copied privately
 * for each run. It cannot enforce `agentEgress` yet, so repositories that declare it refuse pi agents.
 */
export const piProfile: HarnessProfile = {
  name: "pi",
  // pi runs only without egress for now, so it never goes through a control-plane proxy.
  controlPlaneHosts: [],
  controlPlaneEnvironment: [PI_AGENT_DIRECTORY],
  configDirectoryVariable: PI_AGENT_DIRECTORY,
  sandbox: "access",
  optionalShell: true,
  confinedAccess: false,
  workspaceWriteNeedsNetwork: true,
  agentEgress: false,
};
