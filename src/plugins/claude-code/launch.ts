import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { startRunNetwork, withBridgeSockets, type AgentNetworkPolicy, type CredentialRelayPolicy, type EgressInput, type RunNetwork } from "../../isolation/run-network";
import { agentLaunchCommand, verifyAgentWrapper, type AgentFilesystemOptions } from "../../isolation/sandbox";
import { LoginRefreshUnavailableError, LoginRenewalError, loginAccessToken, type RefreshOptions } from "./login-refresh";

/** Hosts Claude Code itself needs for its model API and authentication. */
export const CLAUDE_CONTROL_PLANE_HOSTS: readonly string[] = ["api.anthropic.com", "console.anthropic.com", "platform.claude.com", "claude.ai"];

/** The model API the credential relay forwards to. */
export const CLAUDE_UPSTREAM = "https://api.anthropic.com";
/** The file Claude Code's login writes in its config directory. */
export const CLAUDE_CREDENTIAL_FILE = ".credentials.json";

/** What commands Claude Code runs must not inherit: its config directory, its credential variables and the run's `programVariables`. */
export function claudeCommandUnset(programVariables: readonly string[] = []): string[] {
  return [...new Set(["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", ...programVariables])];
}

/** Why the login file could not supply a token, as the run's last request saw it. */
export type LoginFailure = "renew" | "unavailable";

/**
 * Splits the run's environment into what the sandbox gets and the relay policy that holds the real
 * credential on the host: the OAuth token in the environment, else the API key (sent as `x-api-key`),
 * else the access token in the service user's login file, read again for every request and refreshed
 * on the host first when it is about to expire (only this credential is ever refreshed).
 * `loginFailure` says why the login file last failed to supply a token (null after a success).
 * `relay` overrides only the upstream, port and trust anchor, and `refresh` the refresh endpoint and its
 * trust anchor (test seams).
 */
export function claudeCredentials(
  environment: Record<string, string>,
  configDirectory: string,
  relay?: Partial<CredentialRelayPolicy>,
  refresh?: RefreshOptions,
): { environment: Record<string, string>; relay: CredentialRelayPolicy; loginFailure: () => LoginFailure | null } {
  const { CLAUDE_CODE_OAUTH_TOKEN: token, ANTHROPIC_API_KEY: apiKey, ANTHROPIC_BASE_URL: _baseUrl, ...rest } = environment;
  const file = path.join(configDirectory, CLAUDE_CREDENTIAL_FILE);
  let failure: LoginFailure | null = null;
  const fromFile = async (): Promise<string> => {
    try {
      const accessToken = await loginAccessToken(file, refresh);
      failure = null;
      return accessToken;
    } catch (error) {
      if (error instanceof LoginRenewalError) failure = "renew";
      else if (error instanceof LoginRefreshUnavailableError) failure = "unavailable";
      throw error;
    }
  };
  const useKey = !token && Boolean(apiKey);
  return {
    environment: rest,
    loginFailure: () => failure,
    relay: {
      upstream: relay?.upstream ?? CLAUDE_UPSTREAM,
      credential: token ? () => token : apiKey ? () => apiKey : fromFile,
      ...(useKey ? { credentialHeader: "x-api-key" as const } : {}),
      ...(relay?.port ? { port: relay.port } : {}),
      ...(relay?.ca ? { ca: relay.ca } : {}),
    },
  };
}

/** Where a run's shell prefix is written (`<artifacts>/net/shell-prefix`), its directory created. */
export async function claudePrefixFile(artifactsDirectory: string): Promise<string> {
  await mkdir(path.join(artifactsDirectory, "net"), { recursive: true });
  return path.join(artifactsDirectory, "net", "shell-prefix");
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Writes the executable `CLAUDE_CODE_SHELL_PREFIX` names. Claude Code runs the prefix as one program
 * path, never as a word-split command line, and hands it exactly one argument: a complete command
 * string written for its own shell (`$SHELL`, which Conveyor sets to bash). It also launches MCP servers this way, as one string.
 * So the policy lives in a script that removes the variables the harness holds for itself, sets the
 * data-plane proxy environment and runs that string with `$SHELL -c`.
 * Returns the script's path, which contains no whitespace.
 */
export async function writeClaudeShellPrefix(file: string, dataEnv: Record<string, string>, unset: readonly string[] = claudeCommandUnset()): Promise<string> {
  if (/\s/.test(file)) throw new Error(`cannot use ${JSON.stringify(file)} as the Claude Code shell prefix: the path contains whitespace; use a settings.artifacts directory without spaces`);
  const lines = [
    "#!/bin/sh",
    `unset ${unset.join(" ")}`,
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
 * model API through the run's credential relay (`ANTHROPIC_BASE_URL`), authenticating with the relay's
 * placeholder; its commands get only the data-plane proxy. `egress` must carry the relay. The caller closes `network` when the run ends.
 */
export async function claudeLaunch(options: {
  command: string;
  environment: Record<string, string>;
  artifactsDirectory: string;
  egress: EgressInput;
  filesystem: AgentFilesystemOptions;
  /** What the prefix removes before each command (see claudeCommandUnset). */
  unset?: readonly string[];
  buildArguments: () => string[];
}): Promise<{ argv: string[]; env: Record<string, string>; network: RunNetwork }> {
  const policy: AgentNetworkPolicy = { ...options.egress, controlPlaneHosts: options.egress.controlPlaneHosts ?? CLAUDE_CONTROL_PLANE_HOSTS };
  const network = await startRunNetwork({ directory: path.join(options.artifactsDirectory, "net"), policy });
  try {
    const relay = network.relay;
    if (!relay) throw new Error("a Claude Code run requires the credential relay");
    // Only the placeholder: the real credential stays with the relay on the host.
    const harnessEnvironment = { ...options.environment, ANTHROPIC_BASE_URL: relay.url, CLAUDE_CODE_OAUTH_TOKEN: relay.placeholder };
    const command = agentLaunchCommand(options.filesystem);
    const build = () => [command, ...options.buildArguments()];
    let dataEnv: Record<string, string> = {};
    // The wrapper is pure; the first pass only learns the command proxy environment the second needs.
    network.wrap(harnessEnvironment, (env) => { dataEnv = env; return build(); }, withBridgeSockets(options.filesystem, policy));
    const prefixFile = path.join(options.artifactsDirectory, "net", "shell-prefix");
    const prefix = await writeClaudeShellPrefix(prefixFile, dataEnv, options.unset);
    // Bound read-only over the writable artifacts mount, so the agent cannot rewrite its own prefix.
    const filesystem = withBridgeSockets({ ...options.filesystem, readable: [...(options.filesystem.readable ?? []), prefix] }, policy);
    const sandboxed = network.wrap(
      { ...harnessEnvironment, CLAUDE_CODE_SHELL_PREFIX: prefix, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      build,
      filesystem,
    );
    verifyAgentWrapper(sandboxed, command);
    const owned: RunNetwork = { wrap: network.wrap, ...(network.relay ? { relay: network.relay } : {}), close: async () => { await network.close(); await rm(prefix, { force: true }); } };
    return { argv: sandboxed.argv, env: sandboxed.env, network: owned };
  } catch (error) {
    await network.close();
    await rm(path.join(options.artifactsDirectory, "net", "shell-prefix"), { force: true });
    throw error;
  }
}
