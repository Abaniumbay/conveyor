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
    "item.get",
    "item.guidance",
    "workspace.get",
    "change.get",
    "conversation.get",
    "agent.reportProgress",
    "agent.askQuestion",
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

interface Seen { tool: string; input: unknown }

describe("Conveyor MCP server", () => {
  test("lists only the granted tools, under canonical camelCase names with registry descriptions and schemas", async () => {
    const client = await connectedClient({ async call() { throw new Error("no call expected"); } });
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...context.allowedTools].sort());
    const progress = tools.tools.find((tool) => tool.name === "agent.reportProgress")!;
    expect(progress.description).toContain("progress");
    expect(progress.inputSchema.properties).toHaveProperty("message");
  });

  test("a legacy snake_case grant lists canonical names and legacy names still work in calls", async () => {
    const seen: Seen[] = [];
    const client = await connectedClient({
      async call(tool, input) { seen.push({ tool, input }); return { ok: true }; },
    }, ["source.get_issue", "run.report_progress", "workspace.record_artifact"]);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["agent.recordArtifact", "agent.reportProgress", "item.get"]);
    expect(text(await client.callTool({ name: "source.get_issue", arguments: {} }))).toEqual({ ok: true });
    expect(seen[0]?.tool).toBe("item.get");
  });

  test("serves every getter live through the control client, workspace.get included", async () => {
    const seen: Seen[] = [];
    const client = await connectedClient({
      async call(tool, input) { seen.push({ tool, input }); return { tool }; },
    });
    expect(text(await client.callTool({ name: "workspace.get", arguments: {} }))).toEqual({ tool: "workspace.get" });
    expect(text(await client.callTool({ name: "item.guidance", arguments: {} }))).toEqual({ tool: "item.guidance" });
    expect(text(await client.callTool({ name: "change.get", arguments: {} }))).toEqual({ tool: "change.get" });
    expect(seen.map((call) => call.tool)).toEqual(["workspace.get", "item.guidance", "change.get"]);
  });

  test("the run scope is added to every call and overwrites an agent-supplied issueId", async () => {
    const seen: Seen[] = [];
    const client = await connectedClient({
      async call(tool, input) { seen.push({ tool, input }); return { accepted: true }; },
    });
    await client.callTool({ name: "agent.reportProgress", arguments: { message: "one", issueId: "other", runId: "forged" } });
    expect(seen[0]?.input).toMatchObject({ message: "one", runId: "run-1", stageId: "implementation", repositoryId: "repo-1", issueId: "issue-1" });
  });

  test("a tool outside the grant is refused without reaching the control client", async () => {
    const seen: Seen[] = [];
    const client = await connectedClient({ async call(tool, input) { seen.push({ tool, input }); return {}; } });
    const result = await client.callTool({ name: "item.comment", arguments: { markdown: "x" } });
    expect(result.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  test("invalid input is an MCP error carrying the validation message", async () => {
    const seen: Seen[] = [];
    const client = await connectedClient({ async call(tool, input) { seen.push({ tool, input }); return {}; } });
    const result = await client.callTool({ name: "agent.reportProgress", arguments: { message: 5 } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("message");
    expect(seen).toEqual([]);
  });

  test("a control failure is returned as an MCP error", async () => {
    const client = await connectedClient({ async call() { throw new Error("headSha old is not the current change head new"); } });
    const result = await client.callTool({ name: "change.get", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("headSha old is not the current change head new");
  });

  test("rejects unknown or duplicate tool grants instead of silently weakening config", () => {
    const control: ControlClient = { async call() {} };
    expect(() => createConveyorMcpServer({ ...context, allowedTools: ["item.get", "source.typo"] }, control)).toThrow("unsupported MCP tool");
    expect(() => createConveyorMcpServer({ ...context, allowedTools: ["item.get", "source.get_issue"] }, control)).toThrow("duplicate MCP tool");
  });
});
