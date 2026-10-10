import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { canonicalToolName } from "../tasks/aliases";
import { createTaskRegistry } from "../tasks/catalogue";
import { BUILD } from "../version";
import { conveyorToolGuidance } from "./guidance";

export interface RunMcpContext {
  version: 1;
  runId: string;
  stageId: string;
  repository: { id: string; address: string; baseBranch: string };
  issue: {
    id: string;
    number: number;
    title: string;
    body: string;
    labels: string[];
    url: string;
  };
  workspace: { path: string; branch: string } | null;
  delivery: { pullRequest: unknown | null; checks: unknown[] };
  sourceGuidance: string;
  control: { url: string; token: string };
  allowedTools: string[];
}

export interface ControlClient {
  call(tool: string, input: unknown): Promise<unknown>;
}

type FetchImplementation = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;

export class HttpControlClient implements ControlClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: FetchImplementation = fetch,
    private readonly sleep: (milliseconds: number) => Promise<void> = async (milliseconds) => { await Bun.sleep(milliseconds); },
  ) {}

  async call(tool: string, input: unknown): Promise<unknown> {
    const retries = [50, 100, 200];
    // A response can be lost after the service has accepted the request. Keep this identifier
    // stable across transport retries so the service can return the original result instead of
    // applying a tool mutation twice.
    const callId = randomUUID();
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
            "x-conveyor-call-id": callId,
          },
          body: JSON.stringify({ tool, input }),
        });
      } catch (error) {
        if (!isTransientControlTransportError(error) || attempt === retries.length) throw error;
        await this.sleep(retries[attempt]!);
        continue;
      }
      if (!response.ok) {
        throw new Error(`control request failed (${response.status}): ${await response.text()}`);
      }
      return response.json();
    }
  }
}

function isTransientControlTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /socket connection was closed|socket hang up|fetch failed|network error|connection (?:reset|refused)|econnreset|econnrefused|epipe/i.test(message);
}

const errorResult = (message: string) => ({ isError: true as const, content: [{ type: "text" as const, text: message }] });

/**
 * Lists the registry's `tool` tasks the grant allows (canonical camelCase names; legacy
 * snake_case grant entries are resolved through the alias table) and forwards every call, with a
 * fresh call id, to the service, which enforces the grant again and runs the task.
 */
export function createConveyorMcpServer(context: RunMcpContext, control: ControlClient): Server {
  const server = new Server(
    { name: "conveyor", version: BUILD.version },
    { capabilities: { tools: {} }, instructions: conveyorToolGuidance(context.allowedTools) },
  );

  const tools = new Map(createTaskRegistry().list("tool").map((task) => [task.name, task]));
  const granted = new Set<string>();
  for (const entry of context.allowedTools) {
    const name = canonicalToolName(entry);
    if (!tools.has(name)) throw new Error(`unsupported MCP tool grant: ${entry}`);
    if (granted.has(name)) throw new Error(`duplicate MCP tool grant: ${entry}`);
    granted.add(name);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...granted].map((name) => {
      const task = tools.get(name)!;
      const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(task.input!, { io: "input", unrepresentable: "any" });
      return { name, description: task.description, inputSchema: { type: "object" as const, ...inputSchema } };
    }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = canonicalToolName(request.params.name);
    const task = tools.get(name);
    if (!task || !granted.has(name)) return errorResult(`MCP tool is not granted: ${request.params.name}`);
    const parsed = task.input!.safeParse(request.params.arguments ?? {});
    if (!parsed.success) return errorResult(`Invalid input for ${name}: ${parsed.error.message}`);
    try {
      const result = await control.call(name, {
        ...(parsed.data as Record<string, unknown>),
        runId: context.runId,
        stageId: context.stageId,
        repositoryId: context.repository.id,
        issueId: context.issue.id,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  return server;
}
