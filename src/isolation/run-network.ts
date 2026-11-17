import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type net from "node:net";

import { startCredentialRelay } from "./credential-relay";
import { startTcpRelay } from "./tcp-relay";

import { startEgressProxy, type EgressProxy } from "./egress-proxy";
import { agentFilesystemPlan, sandboxCommand, type AgentFilesystemOptions, type SandboxedCommand } from "./sandbox";

/** A sandbox loopback port and the host source it reaches: a Unix socket or a loopback TCP listener. */
export type LocalServiceForward = { port: number; socket: string } | { port: number; tcp: { host: string; port: number } };

/** A host-side relay that forwards the run's requests to one HTTPS upstream with a real credential substituted. */
export interface CredentialRelayPolicy {
  /** HTTPS base URL the relay forwards to. */
  upstream: string;
  /** The real credential, read on the host for every request and never given to the sandbox. */
  credential: () => string | Promise<string>;
  /** Sandbox loopback port of the relay endpoint (default 3140). */
  port?: number;
  /** Test seam: extra trust anchor for the upstream certificate. */
  ca?: string | Buffer;
}

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
  /** Credential relay reachable at a loopback endpoint inside the sandbox, with or without egress hosts. */
  relay?: CredentialRelayPolicy;
  /** Test seams: DNS resolution and upstream dialing. */
  resolve?: (host: string) => Promise<string[]>;
  dial?: (address: string, port: number) => net.Socket;
}

/** The relay endpoint of a run: the sandbox loopback URL and the random placeholder that stands for the credential. */
export interface RunRelay {
  url: string;
  placeholder: string;
}

export interface RunNetwork {
  /** Present when the policy configures a credential relay. */
  relay?: RunRelay;
  /** Wraps the harness command; `build` receives the data-plane proxy environment for its commands. */
  wrap(env: Record<string, string>, build: (dataEnv: Record<string, string>) => string[], filesystem?: AgentFilesystemOptions): SandboxedCommand;
  close(): Promise<void>;
}

// A Unix socket path must fit sockaddr_un.sun_path (108 bytes including the terminator).
export const MAX_SOCKET_PATH = 100;
const DEFAULT_RELAY_PORT = 3140;

/**
 * Per-run network plumbing under `directory`: a data-plane proxy for commands, a token-protected
 * control-plane proxy for the harness's own endpoint, and the sandbox launcher that wires both.
 */
export async function startRunNetwork(options: { directory: string; policy: AgentNetworkPolicy }): Promise<RunNetwork> {
  const { directory, policy } = options;
  const dataSocket = path.join(directory, "data.sock");
  const controlSocket = path.join(directory, "control.sock");
  const relaySocket = path.join(directory, "relay.sock");
  const relayPort = policy.relay?.port ?? DEFAULT_RELAY_PORT;
  if (policy.relay) {
    const taken = [...(policy.localServices ?? []).map((service) => service.port), ...(policy.mcp ? [policy.mcp.port] : [])];
    if (taken.includes(relayPort)) throw new Error(`the credential relay port ${relayPort} collides with another forwarded loopback port`);
  }
  for (const socket of [dataSocket, controlSocket, ...(policy.relay ? [relaySocket] : [])]) {
    if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) {
      throw new Error(`cannot create an egress socket at ${socket}: path is longer than ${MAX_SOCKET_PATH} bytes; use a shorter settings.artifacts directory`);
    }
  }
  await mkdir(directory, { recursive: true });
  const token = randomBytes(32).toString("base64url");
  const seams = { ...(policy.resolve ? { resolve: policy.resolve } : {}), ...(policy.dial ? { dial: policy.dial } : {}) };
  const proxies: EgressProxy[] = [];
  const localServices: { port: number; socket: string }[] = [];
  const relay: RunRelay | undefined = policy.relay
    ? { url: `http://127.0.0.1:${relayPort}`, placeholder: randomBytes(32).toString("base64url") }
    : undefined;
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
    if (policy.relay && relay) {
      proxies.push(await startCredentialRelay({
        socketPath: relaySocket,
        upstream: policy.relay.upstream,
        credential: policy.relay.credential,
        placeholder: relay.placeholder,
        ...(policy.relay.ca ? { ca: policy.relay.ca } : {}),
      }));
    }
  } catch (error) {
    await Promise.all(proxies.map((proxy) => proxy.close()));
    throw error;
  }
  let closed: Promise<void> | undefined;
  return {
    ...(relay ? { relay } : {}),
    wrap(env, build, filesystem) {
      const commandEnvironment = {
        ...env,
        ...policy.localServiceEnvironment,
        ...(relay ? { CONVEYOR_RELAY_URL: relay.url, CONVEYOR_RELAY_PLACEHOLDER: relay.placeholder } : {}),
      };
      const forwards = {
        ...(localServices.length > 0 ? { localServices } : {}),
        ...(relay ? { relay: { port: relayPort, socket: relaySocket } } : {}),
      };
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

export type EgressInput = Omit<AgentNetworkPolicy, "controlPlaneHosts"> & { controlPlaneHosts?: readonly string[] | undefined };

/**
 * The filesystem plus the host sockets the in-namespace bridge forwards to. A harness launch passes
 * its filesystem through this before wrapping it in the run network.
 */
export function withBridgeSockets(filesystem: AgentFilesystemOptions, policy: AgentNetworkPolicy): AgentFilesystemOptions {
  const bridgeSockets = [
    ...(policy.mcp ? [policy.mcp.socket] : []),
    ...(policy.localServices ?? []).flatMap((service) => "socket" in service ? [service.socket] : []),
  ];
  return bridgeSockets.length > 0 ? { ...filesystem, readable: [...(filesystem.readable ?? []), ...bridgeSockets] } : filesystem;
}
