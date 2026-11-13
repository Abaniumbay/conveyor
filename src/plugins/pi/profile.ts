import type { HarnessProfile } from "../../harness/types";
import { PI_AGENT_DIRECTORY } from "./agent-directory";
import { piControlPlaneHosts } from "./launch";

/**
 * pi derives its sandbox from the agent's access, may run without a shell, cannot run confined
 * agents, and needs the network for a workspace-write agent. Conveyor's empty-root sandbox is its
 * only sandbox. Its login stays in its agent directory (the runner's `configDir`), copied privately
 * for each run. Under `agentEgress` the hosts its process reaches follow the runner's provider.
 */
export const piProfile: HarnessProfile = {
  name: "pi",
  // No provider-independent default: the runner's provider decides.
  controlPlaneHosts: [],
  controlPlaneHostsFor: (runner) => piControlPlaneHosts({ provider: "provider" in runner && typeof runner.provider === "string" ? runner.provider : undefined }),
  controlPlaneEnvironment: [PI_AGENT_DIRECTORY],
  configDirectoryVariable: PI_AGENT_DIRECTORY,
  sandbox: "access",
  optionalShell: true,
  confinedAccess: false,
  workspaceWriteNeedsNetwork: true,
  agentEgress: true,
};
