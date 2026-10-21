import { resolveFilesystemPath } from "../core/paths";
import type { ConveyorConfig } from "../config/load";
import { mcpSocketPath } from "./mcp-socket";
import type { EgressInput } from "./run-network";

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
 * block (legacy behaviour: sanitized environment only, no sandbox).
 */
export function agentEgressFor(
  config: ConveyorConfig,
  repositoryId: string,
  runner: { controlPlaneHosts?: string[] | undefined },
): EgressInput | undefined {
  const egress = config.repositories?.[repositoryId]?.agentEgress;
  if (!egress) return undefined;
  const services = egress.localServices ?? [];
  for (const service of services) {
    if (isDockerSocket(service.socket)) {
      throw new Error(`agentEgress.localServices.${service.name}.socket must not forward the host Docker socket`);
    }
  }
  const localServices = services.map((service) => ({ port: endpointPort(service.endpoint), socket: service.socket }));
  const localServiceEnvironment = Object.assign({}, ...services.map((service) => service.environment));
  return {
    httpsHosts: egress.httpsHosts,
    controlPlaneHosts: runner.controlPlaneHosts,
    ...(localServices.length > 0 ? { localServices, localServiceEnvironment } : {}),
    ...(egress.allowLoopbackMcp
      ? { mcp: { port: listenPort(config.web.listen), socket: mcpSocketPath(config.settings.artifacts) } }
      : {}),
  };
}
