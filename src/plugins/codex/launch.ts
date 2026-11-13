import path from "node:path";

import { startRunNetwork, withBridgeSockets, type AgentNetworkPolicy, type EgressInput, type RunNetwork } from "../../isolation/run-network";
import { agentFilesystemCommand, agentLaunchCommand, privateTmpCommand, PROXY_VARIABLES, verifyAgentWrapper, type AgentFilesystemOptions } from "../../isolation/sandbox";

/** Hosts Codex itself needs for its model backend and authentication. */
export const CODEX_CONTROL_PLANE_HOSTS: readonly string[] = ["chatgpt.com", "api.openai.com", "auth.openai.com"];

/** `-c` overrides that keep the control-plane proxy out of commands the harness runs. */
export function shellPolicyArguments(dataEnv: Record<string, string>): string[] {
  const set = Object.entries(dataEnv).map(([name, value]) => `${name}=${JSON.stringify(value)}`);
  return [
    "-c",
    `shell_environment_policy.exclude=[${[...PROXY_VARIABLES, "CODEX_HOME"].map((name) => JSON.stringify(name)).join(",")}]`,
    "-c",
    `shell_environment_policy.set={${set.join(",")}}`,
    "-c",
    "sandbox_workspace_write.network_access=true",
  ];
}

/**
 * The argv/env to spawn Codex with its confined filesystem. Egress additionally wraps the command
 * in the network sandbox, and its `network` must be closed when the run ends.
 */
export async function codexLaunch(options: {
  command: string;
  environment: Record<string, string>;
  artifactsDirectory: string;
  egress: EgressInput | undefined;
  /** Full-access Codex must still receive a private /tmp when it has no egress sandbox. */
  privateTmp?: boolean;
  /** Required narrow filesystem for every normal Codex launch. */
  filesystem: AgentFilesystemOptions;
  buildArguments: (extra: string[]) => string[];
}): Promise<{ argv: string[]; env: Record<string, string>; network: RunNetwork | null }> {
  if (!options.egress) {
    const plain = { argv: [options.command, ...options.buildArguments([])], env: options.environment };
    const launch = options.privateTmp ? privateTmpCommand(plain) : agentFilesystemCommand(options.filesystem, plain.argv);
    if (!options.privateTmp) verifyAgentWrapper(launch, agentLaunchCommand(options.filesystem));
    return { argv: launch.argv, env: launch.env, network: null };
  }
  const policy: AgentNetworkPolicy = { ...options.egress, controlPlaneHosts: options.egress.controlPlaneHosts ?? CODEX_CONTROL_PLANE_HOSTS };
  const network = await startRunNetwork({ directory: path.join(options.artifactsDirectory, "net"), policy });
  const filesystem = withBridgeSockets(options.filesystem, policy);
  let command: string;
  try {
    command = agentLaunchCommand(options.filesystem);
  } catch (error) {
    await network.close();
    throw error;
  }
  const sandboxed = network.wrap(options.environment, (dataEnv) => [command, ...options.buildArguments(shellPolicyArguments(dataEnv))], filesystem);
  try {
    verifyAgentWrapper(sandboxed, command);
  } catch (error) {
    await network.close();
    throw error;
  }
  return { argv: sandboxed.argv, env: sandboxed.env, network };
}
