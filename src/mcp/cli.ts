import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadRunMcpContext } from "./context";
import { createConveyorMcpServer, HttpControlClient } from "./server";

function contextPath(args: string[]): string {
  const index = args.indexOf("--context");
  const filename = index >= 0 ? args[index + 1] : undefined;
  if (!filename || filename.startsWith("--")) {
    throw new Error("usage: conveyor __mcp --context <context.json>");
  }
  return filename;
}

export async function runMcpCli(args: string[]): Promise<void> {
  const context = await loadRunMcpContext(contextPath(args));
  const control = new HttpControlClient(context.control.url, context.control.token);
  const server = createConveyorMcpServer(context, control);
  await server.connect(new StdioServerTransport());
}
