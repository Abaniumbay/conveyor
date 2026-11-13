import { chmod, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { startRunNetwork, withBridgeSockets, type AgentNetworkPolicy, type EgressInput, type RunNetwork } from "../../isolation/run-network";
import { agentLaunchCommand, verifyAgentWrapper, type AgentFilesystemOptions } from "../../isolation/sandbox";

/** Hosts Claude Code itself needs for its model API and authentication. */
export const CLAUDE_CONTROL_PLANE_HOSTS: readonly string[] = ["api.anthropic.com", "console.anthropic.com", "platform.claude.com", "claude.ai"];

/** Variables the harness holds for itself that commands it runs must not inherit. */
const CLAUDE_COMMAND_UNSET = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Writes the executable `CLAUDE_CODE_SHELL_PREFIX` names. Claude Code runs the prefix as one program
 * path, never as a word-split command line, and hands it exactly one argument: a complete command
 * string written for its own shell (`$SHELL`, which Conveyor sets to bash). It also launches MCP servers this way, as one string.
 * So the policy lives in a script that removes the variables the harness holds for itself, sets the
 * data-plane proxy environment and runs that string with `$SHELL -c`.
 * Returns the script's path, which contains no whitespace.
 */
export async function writeClaudeShellPrefix(file: string, dataEnv: Record<string, string>): Promise<string> {
  if (/\s/.test(file)) throw new Error(`cannot use ${JSON.stringify(file)} as the Claude Code shell prefix: the path contains whitespace; use a settings.artifacts directory without spaces`);
  const lines = [
    "#!/bin/sh",
    `unset ${CLAUDE_COMMAND_UNSET.join(" ")}`,
    ...Object.entries(dataEnv).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    'exec "$SHELL" -c "$1"',
    "",
  ];
  await writeFile(file, lines.join("\n"), { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

/**
 * The argv/env to spawn Claude Code inside the run's network namespace. The process reaches its
 * model API through the token-protected control-plane proxy; its commands get only the data-plane proxy.
 * The caller closes `network` when the run ends.
 */
export async function claudeLaunch(options: {
  command: string;
  environment: Record<string, string>;
  artifactsDirectory: string;
  egress: EgressInput;
  filesystem: AgentFilesystemOptions;
  buildArguments: () => string[];
}): Promise<{ argv: string[]; env: Record<string, string>; network: RunNetwork }> {
  const policy: AgentNetworkPolicy = { ...options.egress, controlPlaneHosts: options.egress.controlPlaneHosts ?? CLAUDE_CONTROL_PLANE_HOSTS };
  const network = await startRunNetwork({ directory: path.join(options.artifactsDirectory, "net"), policy });
  try {
    const command = agentLaunchCommand(options.filesystem);
    const build = () => [command, ...options.buildArguments()];
    let dataEnv: Record<string, string> = {};
    // The wrapper is pure; the first pass only learns the command proxy environment the second needs.
    network.wrap(options.environment, (env) => { dataEnv = env; return build(); }, withBridgeSockets(options.filesystem, policy));
    const prefixFile = path.join(options.artifactsDirectory, "net", "shell-prefix");
    const prefix = await writeClaudeShellPrefix(prefixFile, dataEnv);
    // Bound read-only over the writable artifacts mount, so the agent cannot rewrite its own prefix.
    const filesystem = withBridgeSockets({ ...options.filesystem, readable: [...(options.filesystem.readable ?? []), prefix] }, policy);
    const sandboxed = network.wrap(
      { ...options.environment, CLAUDE_CODE_SHELL_PREFIX: prefix, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      build,
      filesystem,
    );
    verifyAgentWrapper(sandboxed, command);
    const owned: RunNetwork = { wrap: network.wrap, close: async () => { await network.close(); await rm(prefix, { force: true }); } };
    return { argv: sandboxed.argv, env: sandboxed.env, network: owned };
  } catch (error) {
    await network.close();
    await rm(path.join(options.artifactsDirectory, "net", "shell-prefix"), { force: true });
    throw error;
  }
}
