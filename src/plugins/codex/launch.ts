import path from "node:path";

import { startRunNetwork, withBridgeSockets, type AgentNetworkPolicy, type EgressInput, type RunNetwork } from "../../isolation/run-network";
import { agentFilesystemCommand, agentLaunchCommand, privateTmpCommand, PROXY_VARIABLES, verifyAgentWrapper, type AgentFilesystemOptions } from "../../isolation/sandbox";

/** Hosts Codex itself needs for its model backend and authentication. */
export const CODEX_CONTROL_PLANE_HOSTS: readonly string[] = ["chatgpt.com", "api.openai.com", "auth.openai.com"];

/**
 * The file that marks a standalone Codex release: its installer keeps one release per directory
 * (`~/.codex/packages/standalone/releases/<version>/`) and Codex finds its `bin/codex-code-mode-host`
 * helper and `codex-resources/` relative to its own resolved path, so that root is mounted read-only.
 */
export const CODEX_RELEASE_MANIFEST = "codex-package.json";

/** The `-c` override that keeps these variables out of every command Codex runs. */
function shellExclusionArguments(excluded: readonly string[]): string[] {
  return ["-c", `shell_environment_policy.exclude=[${[...new Set(excluded)].map((name) => JSON.stringify(name)).join(",")}]`];
}

/**
 * `-c` overrides that keep the control-plane proxy, the private Codex home and the run's
 * `programVariables` (the harness level's environment) out of commands the harness runs.
 */
export function shellPolicyArguments(dataEnv: Record<string, string>, programVariables: readonly string[] = []): string[] {
  const set = Object.entries(dataEnv).map(([name, value]) => `${name}=${JSON.stringify(value)}`);
  return [
    ...shellExclusionArguments([...PROXY_VARIABLES, "CODEX_HOME", ...programVariables]),
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
  /** Variables for Codex itself that its commands must not inherit (the harness level's environment). */
  programVariables?: readonly string[] | undefined;
  buildArguments: (extra: string[]) => string[];
}): Promise<{ argv: string[]; env: Record<string, string>; network: RunNetwork | null }> {
  const confined: AgentFilesystemOptions = { ...options.filesystem, releaseManifest: CODEX_RELEASE_MANIFEST };
  if (!options.egress) {
    const exclusion = shellExclusionArguments(["CODEX_HOME", ...(options.programVariables ?? [])]);
    const plain = { argv: [options.command, ...options.buildArguments(exclusion)], env: options.environment };
    const launch = options.privateTmp ? privateTmpCommand(plain) : agentFilesystemCommand(confined, plain.argv);
    if (!options.privateTmp) verifyAgentWrapper(launch, agentLaunchCommand(confined));
    return { argv: launch.argv, env: launch.env, network: null };
  }
  const policy: AgentNetworkPolicy = { ...options.egress, controlPlaneHosts: options.egress.controlPlaneHosts ?? CODEX_CONTROL_PLANE_HOSTS };
  const network = await startRunNetwork({ directory: path.join(options.artifactsDirectory, "net"), policy });
  const filesystem = withBridgeSockets(confined, policy);
  let command: string;
  try {
    command = agentLaunchCommand(confined);
  } catch (error) {
    await network.close();
    throw error;
  }
  const sandboxed = network.wrap(options.environment, (dataEnv) => [command, ...options.buildArguments(shellPolicyArguments(dataEnv, options.programVariables))], filesystem);
  try {
    verifyAgentWrapper(sandboxed, command);
  } catch (error) {
    await network.close();
    throw error;
  }
  return { argv: sandboxed.argv, env: sandboxed.env, network };
}
