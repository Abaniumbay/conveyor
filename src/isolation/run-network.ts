import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type net from "node:net";

import { startTcpRelay } from "./tcp-relay";

import { startEgressProxy, type EgressProxy } from "./egress-proxy";
import { agentFilesystemCommand, agentFilesystemPlan, privateTmpCommand, PROXY_VARIABLES, sandboxCommand, verifyAgentWrapper, type AgentFilesystemOptions, type SandboxedCommand } from "./sandbox";

/** A sandbox loopback port and the host source it reaches: a Unix socket or a loopback TCP listener. */
export type LocalServiceForward = { port: number; socket: string } | { port: number; tcp: { host: string; port: number } };

export interface AgentNetworkPolicy {
  /** Hosts commands run by the agent may reach on 443 (the repository's `agentEgress.httpsHosts`). */
  httpsHosts: readonly string[];
  /** Hosts the harness itself may reach (its model endpoint). */
  controlPlaneHosts: readonly string[];
  /** The service's MCP endpoint, present when `agentEgress.allowLoopbackMcp` is true. */
  mcp?: { port: number; socket: string };
  /** Repository-declared host Unix services, each exposed only at its fixed sandbox loopback port. */
  localServices?: readonly LocalServiceForward[];
  /** Connection details for those services, passed to commands but never to the host environment. */
  localServiceEnvironment?: Readonly<Record<string, string>>;
  /** Test seams: DNS resolution and upstream dialing. */
  resolve?: (host: string) => Promise<string[]>;
  dial?: (address: string, port: number) => net.Socket;
}

export interface RunNetwork {
  /** Wraps the harness command; `build` receives the data-plane proxy environment for its commands. */
  wrap(env: Record<string, string>, build: (dataEnv: Record<string, string>) => string[], filesystem?: AgentFilesystemOptions): SandboxedCommand;
  close(): Promise<void>;
}

// A Unix socket path must fit sockaddr_un.sun_path (108 bytes including the terminator).
export const MAX_SOCKET_PATH = 100;

/**
 * Per-run network plumbing under `directory`: a data-plane proxy for commands, a token-protected
 * control-plane proxy for the harness's own endpoint, and the sandbox launcher that wires both.
 */
export async function startRunNetwork(options: { directory: string; policy: AgentNetworkPolicy }): Promise<RunNetwork> {
  const { directory, policy } = options;
  const dataSocket = path.join(directory, "data.sock");
  const controlSocket = path.join(directory, "control.sock");
  for (const socket of [dataSocket, controlSocket]) {
    if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) {
      throw new Error(`cannot create an egress socket at ${socket}: path is longer than ${MAX_SOCKET_PATH} bytes; use a shorter settings.artifacts directory`);
    }
  }
  await mkdir(directory, { recursive: true });
  const token = randomBytes(32).toString("base64url");
  const seams = { ...(policy.resolve ? { resolve: policy.resolve } : {}), ...(policy.dial ? { dial: policy.dial } : {}) };
  const proxies: EgressProxy[] = [];
  const localServices: { port: number; socket: string }[] = [];
  try {
    for (const service of policy.localServices ?? []) {
      if ("socket" in service) {
        localServices.push(service);
        continue;
      }
      const relay = await startTcpRelay({ socketPath: path.join(directory, `service-${service.port}.sock`), ...service.tcp });
      proxies.push(relay);
      localServices.push({ port: service.port, socket: relay.socketPath });
    }
    proxies.push(await startEgressProxy({ socketPath: dataSocket, allowedHosts: policy.httpsHosts, ...seams }));
    proxies.push(await startEgressProxy({ socketPath: controlSocket, allowedHosts: policy.controlPlaneHosts, token, ...seams }));
  } catch (error) {
    await Promise.all(proxies.map((proxy) => proxy.close()));
    throw error;
  }
  let closed: Promise<void> | undefined;
  return {
    wrap(env, build, filesystem) {
      const commandEnvironment = { ...env, ...policy.localServiceEnvironment };
      const forwards = localServices.length > 0 ? { localServices } : {};
      const probe = sandboxCommand({ argv: [], env: commandEnvironment, dataProxySocket: dataSocket, ...(policy.mcp ? { mcp: policy.mcp } : {}), ...forwards });
      return sandboxCommand({
        argv: build(probe.dataEnv),
        env: commandEnvironment,
        dataProxySocket: dataSocket,
        controlProxySocket: controlSocket,
        controlToken: token,
        ...(policy.mcp ? { mcp: policy.mcp } : {}),
        ...forwards,
        ...(filesystem ? { filesystem: agentFilesystemPlan(filesystem) } : {}),
      });
    },
    close() {
      closed ??= Promise.all(proxies.map((proxy) => proxy.close())).then(() => undefined);
      return closed;
    },
  };
}

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

export type EgressInput = Omit<AgentNetworkPolicy, "controlPlaneHosts"> & { controlPlaneHosts?: readonly string[] | undefined };

/** Hosts Codex itself needs for its model backend and authentication. */
export const CODEX_CONTROL_PLANE_HOSTS: readonly string[] = ["chatgpt.com", "api.openai.com", "auth.openai.com"];

/** The filesystem plus the host sockets the in-namespace bridge forwards to. */
function withBridgeSockets(filesystem: AgentFilesystemOptions, policy: AgentNetworkPolicy): AgentFilesystemOptions {
  const bridgeSockets = [
    ...(policy.mcp ? [policy.mcp.socket] : []),
    ...(policy.localServices ?? []).flatMap((service) => "socket" in service ? [service.socket] : []),
  ];
  return bridgeSockets.length > 0 ? { ...filesystem, readable: [...(filesystem.readable ?? []), ...bridgeSockets] } : filesystem;
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
    return { argv: launch.argv, env: launch.env, network: null };
  }
  const policy: AgentNetworkPolicy = { ...options.egress, controlPlaneHosts: options.egress.controlPlaneHosts ?? CODEX_CONTROL_PLANE_HOSTS };
  const network = await startRunNetwork({ directory: path.join(options.artifactsDirectory, "net"), policy });
  const filesystem = withBridgeSockets(options.filesystem, policy);
  const sandboxed = network.wrap(options.environment, (dataEnv) => [options.command, ...options.buildArguments(shellPolicyArguments(dataEnv))], filesystem);
  try {
    verifyAgentWrapper(sandboxed);
  } catch (error) {
    await network.close();
    throw error;
  }
  return { argv: sandboxed.argv, env: sandboxed.env, network };
}

/** Hosts Claude Code itself needs for its model API and authentication. */
export const CLAUDE_CONTROL_PLANE_HOSTS: readonly string[] = ["api.anthropic.com", "console.anthropic.com", "platform.claude.com", "claude.ai"];

/** Variables the harness holds for itself that commands it runs must not inherit. */
const CLAUDE_COMMAND_UNSET = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;

/**
 * `CLAUDE_CODE_SHELL_PREFIX` for Claude Code: its `Bash` commands run under the data-plane proxy
 * environment, while the process itself keeps the control-plane proxy (and its token) for the model API.
 */
export function claudeShellPrefix(dataEnv: Record<string, string>): string {
  const unset = CLAUDE_COMMAND_UNSET.flatMap((name) => ["-u", name]);
  const set = Object.entries(dataEnv).map(([name, value]) => `${name}=${value}`);
  return ["/usr/bin/env", ...unset, ...set].join(" ");
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
    const filesystem = withBridgeSockets(options.filesystem, policy);
    const build = () => [options.command, ...options.buildArguments()];
    let dataEnv: Record<string, string> = {};
    // The wrapper is pure; the first pass only learns the command proxy environment the second needs.
    network.wrap(options.environment, (env) => { dataEnv = env; return build(); }, filesystem);
    const sandboxed = network.wrap(
      { ...options.environment, CLAUDE_CODE_SHELL_PREFIX: claudeShellPrefix(dataEnv), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      build,
      filesystem,
    );
    verifyAgentWrapper(sandboxed);
    return { argv: sandboxed.argv, env: sandboxed.env, network };
  } catch (error) {
    await network.close();
    throw error;
  }
}
