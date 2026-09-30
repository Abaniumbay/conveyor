import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  createConveyorMcpServer,
  type ControlClient,
  type RunMcpContext,
} from "../../src/mcp/server";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const context: RunMcpContext = {
  version: 1,
  runId: "run-1",
  stageId: "implementation",
  repository: {
    id: "repo-1",
    address: "owner/repo",
    baseBranch: "main",
  },
  issue: {
    id: "issue-1",
    number: 12,
    title: "Feature",
    body: "Body",
    labels: ["conveyor", "backend"],
    url: "https://github.com/owner/repo/issues/12",
  },
  workspace: {
    path: "/srv/worktrees/issue-12",
    branch: "conveyor/12-r1-feature",
  },
  delivery: { pullRequest: null, checks: [] },
  sourceGuidance: "Use managed labels and never close an issue.",
  control: {
    url: "http://127.0.0.1:4300/internal/mcp",
    token: "secret-token",
  },
  allowedTools: [
    "source.get_issue",
    "source.get_guidance",
    "workspace.get_context",
    "delivery.get_state",
    "conversation.get",
    "run.report_progress",
    "run.ask_question",
  ],
};

async function connectedClient(
  control: ControlClient,
  allowedTools: string[] = context.allowedTools,
): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createConveyorMcpServer({ ...context, allowedTools }, control);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  clients.push(client);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = result.content as Array<{ type: string; text?: string }>;
  const item = content[0];
  if (!item || item.type !== "text") throw new Error("expected text result");
  if (typeof item.text !== "string") throw new Error("expected text result");
  return JSON.parse(item.text);
}

describe("Conveyor MCP server", () => {
  test("exposes only explicitly allowed scoped tools", async () => {
    const client = await connectedClient({
      async call() {
        throw new Error("control endpoint should not be called");
      },
    });

    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
      [...context.allowedTools].sort(),
    );
    expect(text(await client.callTool({ name: "source.get_issue", arguments: {} }))).toEqual(
      context.issue,
    );
    expect(
      text(await client.callTool({ name: "workspace.get_context", arguments: {} })),
    ).toEqual(context.workspace);
  });

  test("routes progress and structured questions through the control client", async () => {
    const calls: Array<{ tool: string; input: unknown }> = [];
    const client = await connectedClient({
      async call(tool, input) {
        calls.push({ tool, input });
        return { accepted: true };
      },
    });

    expect(
      text(
        await client.callTool({
          name: "conversation.get",
          arguments: { limit: 25 },
        }),
      ),
    ).toEqual({ accepted: true });
    expect(
      text(
        await client.callTool({
          name: "run.report_progress",
          arguments: { message: "Running tests", details: { suite: "unit" } },
        }),
      ),
    ).toEqual({ accepted: true });
    expect(
      text(
        await client.callTool({
          name: "run.ask_question",
          arguments: {
            prompt: "Which layout should be used?",
            reason: "Both satisfy the issue",
            options: [
              { id: "compact", label: "Compact" },
              { id: "spacious", label: "Spacious" },
            ],
            minSelections: 1,
            maxSelections: 1,
            allowFreeText: true,
          },
        }),
      ),
    ).toEqual({ accepted: true });
    expect(calls.map((call) => call.tool)).toEqual([
      "conversation.get",
      "run.report_progress",
      "run.ask_question",
    ]);
    expect(calls[2]?.input).toMatchObject({ runId: "run-1", stageId: "implementation" });
  });

  test("rejects unknown or duplicate tool grants instead of silently weakening config", () => {
    const control: ControlClient = { async call() {} };
    expect(() =>
      createConveyorMcpServer(
        { ...context, allowedTools: ["source.get_issue", "source.typo"] },
        control,
      ),
    ).toThrow("unsupported MCP tool");
    expect(() =>
      createConveyorMcpServer(
        { ...context, allowedTools: ["source.get_issue", "source.get_issue"] },
        control,
      ),
    ).toThrow("duplicate MCP tool");
  });

  test("rejects child-target overrides on context-bound source mutations", async () => {
    const calls: Array<{ tool: string; input: unknown }> = [];
    const client = await connectedClient({
      async call(tool, input) {
        calls.push({ tool, input });
        return { accepted: true };
      },
    }, ["source.set_acceptance_criteria"]);

    const result = await client.callTool({
      name: "source.set_acceptance_criteria",
      arguments: {
        issueId: "different-issue",
        criteria: [{ id: "AC-1", text: "Must remain scoped." }],
      },
    });

    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});
