import { rm } from "node:fs/promises";
import net from "node:net";

import type { EgressProxy } from "./egress-proxy";

/**
 * Serves `socketPath` and pipes each connection to one declared host loopback TCP listener. The
 * sandbox bridge reaches it like any other forwarded Unix socket; nothing else on the host loopback
 * is reachable through it.
 */
export async function startTcpRelay(options: { socketPath: string; host: string; port: number }): Promise<EgressProxy> {
  const connections = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: options.host, port: options.port });
    for (const socket of [client, upstream]) {
      connections.add(socket);
      socket.once("close", () => {
        connections.delete(socket);
        (socket === client ? upstream : client).destroy();
      });
      socket.on("error", () => socket.destroy());
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await rm(options.socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => resolve());
  });
  return {
    socketPath: options.socketPath,
    async close() {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(options.socketPath, { force: true });
    },
  };
}
