import { resolveFilesystemPath } from "../core/paths";
import type { ConveyorConfig } from "../config/load";
import { parseLoopbackTcp } from "./egress-policy";
import { mcpSocketPath } from "./mcp-socket";
import type { CredentialRelayPolicy, EgressInput } from "./run-network";

const DOCKER_SOCKETS = ["/var/run/docker.sock", "/run/docker.sock"] as const;

function listenPort(listen: string): number {
  return Number(listen.slice(listen.lastIndexOf(":") + 1));
}

function endpointPort(endpoint: string): number {
  return Number(endpoint.slice(endpoint.lastIndexOf(":") + 1));
}

function isDockerSocket(socket: string): boolean {
  const resolved = resolveFilesystemPath(socket);
  return DOCKER_SOCKETS.some((dockerSocket) => resolved === resolveFilesystemPath(dockerSocket));
}

/**
 * The network policy for an agent run, or undefined when the repository declares no `agentEgress`
 * block (legacy behaviour: sanitized environment only, no sandbox). A run that asks for a credential
 * relay is always sandboxed: without an `agentEgress` block it gets the relay and empty host allowlists.
 */
export function agentEgressFor(
  config: ConveyorConfig,
  repositoryId: string,
  runner: { controlPlaneHosts?: string[] | undefined; relay?: CredentialRelayPolicy | undefined },
): EgressInput | undefined {
  const egress = config.repositories?.[repositoryId]?.agentEgress;
  if (!egress) return runner.relay ? { httpsHosts: [], controlPlaneHosts: runner.controlPlaneHosts, relay: runner.relay } : undefined;
  const services = egress.localServices ?? [];
  for (const service of services) {
    if (service.socket !== undefined && isDockerSocket(service.socket)) {
      throw new Error(`agentEgress.localServices.${service.name}.socket must not forward the host Docker socket`);
    }
  }
  const localServices = services.map((service) => {
    const port = endpointPort(service.endpoint);
    if (service.socket !== undefined) return { port, socket: service.socket };
    const tcp = parseLoopbackTcp(service.tcp ?? "");
    if (!tcp) throw new Error(`agentEgress.localServices.${service.name} must declare a socket or a loopback tcp endpoint`);
    return { port, tcp };
  });
  if (egress.allowLoopbackMcp) {
    const mcpPort = listenPort(config.web.listen);
    const clash = services.find((service) => endpointPort(service.endpoint) === mcpPort);
    if (clash) {
      throw new Error(`agentEgress.localServices.${clash.name}.endpoint port ${mcpPort} collides with the loopback MCP port`);
    }
  }
  const localServiceEnvironment = Object.assign({}, ...services.map((service) => service.environment));
  return {
    httpsHosts: egress.httpsHosts,
    controlPlaneHosts: runner.controlPlaneHosts,
    ...(runner.relay ? { relay: runner.relay } : {}),
    ...(localServices.length > 0 ? { localServices, localServiceEnvironment } : {}),
    ...(egress.allowLoopbackMcp
      ? { mcp: { port: listenPort(config.web.listen), socket: mcpSocketPath(config.settings.artifacts) } }
      : {}),
  };
}
