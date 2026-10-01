import { rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

/** The Unix socket the service exposes (for the sandbox bridge) that serves only `/internal/mcp`. */
export function mcpSocketPath(artifactsDirectory: string): string {
  return path.join(artifactsDirectory, "mcp.sock");
}

/** Serves `/internal/mcp` of an existing request handler on a Unix socket; every other path is 404. */
export function serveMcpSocket(options: {
  socket: string;
  handler: (request: Request) => Response | Promise<Response>;
}): { stop(force?: boolean): Promise<void> } {
  rmSync(options.socket, { force: true });
  const server = Bun.serve({
    unix: options.socket,
    fetch: (request) =>
      new URL(request.url).pathname === "/internal/mcp"
        ? options.handler(request)
        : new Response("Not found", { status: 404 }),
  });
  return {
    async stop(force = true) {
      await server.stop(force);
      await rm(options.socket, { force: true });
    },
  };
}
