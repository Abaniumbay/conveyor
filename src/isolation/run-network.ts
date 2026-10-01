import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type net from "node:net";

import { startEgressProxy, type EgressProxy } from "./egress-proxy";
import { PROXY_VARIABLES, sandboxCommand, type SandboxedCommand } from "./sandbox";

export interface AgentNetworkPolicy {
  /** Hosts commands run by the agent may reach on 443 (the repository's `agentEgress.httpsHosts`). */
  httpsHosts: readonly string[];
  /** Hosts the harness itself may reach (its model endpoint). */
  controlPlaneHosts: readonly string[];
  /** The service's MCP endpoint, present when `agentEgress.allowLoopbackMcp` is true. */
  mcp?: { port: number; socket: string };
  /** Test seams: DNS resolution and upstream dialing. */
  resolve?: (host: string) => Promise<string[]>;
  dial?: (address: string, port: number) => net.Socket;
}

export interface RunNetwork {
  /** Wraps the harness command; `build` receives the data-plane proxy environment for its commands. */
  wrap(env: Record<string, string>, build: (dataEnv: Record<string, string>) => string[]): SandboxedCommand;
  close(): Promise<void>;
}

// A Unix socket path must fit sockaddr_un.sun_path (108 bytes including the terminator).
const MAX_SOCKET_PATH = 100;

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
  try {
    proxies.push(await startEgressProxy({ socketPath: dataSocket, allowedHosts: policy.httpsHosts, ...seams }));
    proxies.push(await startEgressProxy({ socketPath: controlSocket, allowedHosts: policy.controlPlaneHosts, token, ...seams }));
  } catch (error) {
    await Promise.all(proxies.map((proxy) => proxy.close()));
    throw error;
  }
  let closed: Promise<void> | undefined;
  return {
    wrap(env, build) {
      const probe = sandboxCommand({ argv: [], env, dataProxySocket: dataSocket, ...(policy.mcp ? { mcp: policy.mcp } : {}) });
      return sandboxCommand({
        argv: build(probe.dataEnv),
        env,
        dataProxySocket: dataSocket,
        controlProxySocket: controlSocket,
        controlToken: token,
        ...(policy.mcp ? { mcp: policy.mcp } : {}),
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
    `shell_environment_policy.exclude=[${PROXY_VARIABLES.map((name) => JSON.stringify(name)).join(",")}]`,
    "-c",
    `shell_environment_policy.set={${set.join(",")}}`,
    "-c",
    "sandbox_workspace_write.network_access=true",
  ];
}

export type EgressInput = Omit<AgentNetworkPolicy, "controlPlaneHosts"> & { controlPlaneHosts?: readonly string[] | undefined };

/** Hosts Codex itself needs for its model backend and authentication. */
export const CODEX_CONTROL_PLANE_HOSTS: readonly string[] = ["chatgpt.com", "api.openai.com", "auth.openai.com"];

/**
 * The argv/env to spawn Codex with. Without `egress` it is the plain command; with it, the command
 * is wrapped in the network sandbox and `network` must be closed when the run ends.
 */
export async function codexLaunch(options: {
  command: string;
  environment: Record<string, string>;
  artifactsDirectory: string;
  egress: EgressInput | undefined;
  buildArguments: (extra: string[]) => string[];
}): Promise<{ argv: string[]; env: Record<string, string>; network: RunNetwork | null }> {
  if (!options.egress) {
    return { argv: [options.command, ...options.buildArguments([])], env: options.environment, network: null };
  }
  const policy: AgentNetworkPolicy = { ...options.egress, controlPlaneHosts: options.egress.controlPlaneHosts ?? CODEX_CONTROL_PLANE_HOSTS };
  const network = await startRunNetwork({ directory: path.join(options.artifactsDirectory, "net"), policy });
  const sandboxed = network.wrap(options.environment, (dataEnv) => [options.command, ...options.buildArguments(shellPolicyArguments(dataEnv))]);
  return { argv: sandboxed.argv, env: sandboxed.env, network };
}
