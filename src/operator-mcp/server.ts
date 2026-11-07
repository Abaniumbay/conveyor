import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { log } from "../log/logger";
import { BUILD } from "../version";
import { OPERATOR_TOOLS } from "./registry";
import type { OperatorFacade, OperatorTool } from "./tool";
import { hashOperatorToken } from "./tokens";

export const OPERATOR_MCP_PATH = "/operator-mcp";

export interface OperatorMcpDependencies {
  facade: OperatorFacade;
  /** Whether a token with this hash exists and is not revoked. */
  tokenIsActive: (tokenHash: string) => boolean;
  tools?: readonly OperatorTool[];
}

const errorResult = (message: string) => ({ isError: true as const, content: [{ type: "text" as const, text: message }] });

function createServer(dependencies: OperatorMcpDependencies): Server {
  const tools = new Map((dependencies.tools ?? OPERATOR_TOOLS).map((tool) => [tool.name, tool]));
  const server = new Server({ name: "conveyor-operator", version: BUILD.version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools.values()].map((tool) => {
      const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.inputSchema, { io: "input", unrepresentable: "any" });
      return { name: tool.name, description: tool.description, inputSchema: { type: "object" as const, ...schema } };
    }),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.get(request.params.name);
    if (!tool) return errorResult(`Unknown tool: ${request.params.name}`);
    const parsed = tool.inputSchema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) return errorResult(`Invalid input for ${tool.name}: ${parsed.error.message}`);
    try {
      const result = await tool.handler({ input: parsed.data, facade: dependencies.facade });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      log.warn("Operator MCP tool failed", { tool: tool.name }, error);
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });
  return server;
}

const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });

/**
 * The request handler of the operator MCP endpoint: bearer authentication, then a stateless
 * streamable-HTTP MCP exchange. Nothing runs before the token is known and not revoked.
 */
export function createOperatorMcpHandler(dependencies: OperatorMcpDependencies): (request: Request) => Promise<Response> {
  return async (request) => {
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(request.headers.get("authorization") ?? "");
    if (!match?.[1] || !dependencies.tokenIsActive(hashOperatorToken(match[1]))) return unauthorized();
    const server = createServer(dependencies);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      // Stateless: each request owns its server and transport.
      void server.close().catch(() => {});
    }
  };
}
