import type { ConveyorConfig } from "../config/load";
import { mcpSocketPath } from "./mcp-socket";
import type { EgressInput } from "./run-network";

function listenPort(listen: string): number {
  return Number(listen.slice(listen.lastIndexOf(":") + 1));
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
  return {
    httpsHosts: egress.httpsHosts,
    controlPlaneHosts: runner.controlPlaneHosts,
    ...(egress.allowLoopbackMcp
      ? { mcp: { port: listenPort(config.web.listen), socket: mcpSocketPath(config.settings.artifacts) } }
      : {}),
  };
}
