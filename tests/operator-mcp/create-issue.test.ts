import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import { loadConfig } from "../../src/config/load";
import { COMMANDS } from "../../src/commands/registry";
import { createControlHandler } from "../../src/control/server";
import { ConveyorStore } from "../../src/db/store";
import { ConsoleSink, log, type LogRecord } from "../../src/log/logger";
import { agentGrantableTools, registeredToolNames } from "../../src/mcp/tools";
import { createConveyorMcpServer, type RunMcpContext } from "../../src/mcp/server";
import { OPERATOR_TOOLS } from "../../src/operator-mcp/registry";
import { createOperatorMcpHandler, OPERATOR_MCP_PATH } from "../../src/operator-mcp/server";
import { hashOperatorToken, newOperatorToken } from "../../src/operator-mcp/tokens";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const directories: string[] = [];
const stops: Array<() => void> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  log.configure({ sinks: [new ConsoleSink()] });
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A real service over a fake GitHub that records creations, behind a real operator MCP endpoint. */
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-create-issue-"));
  directories.push(root);
  const records: LogRecord[] = [];
  log.configure({ sinks: [{ write: (record) => void records.push(record) }] });
  await writeFile(path.join(root, "instructions.md"), "Work.");
  await mkdir(path.join(root, "repo"));
  await writeFile(path.join(root, "config.yml"), `
settings:
  database: ${root}/db.sqlite
  logs: ${root}/logs
  workspaces: ${root}/workspaces
  artifacts: ${root}/artifacts
web: {}
sources: { github: { type: github, webhookSecret: secret } }
runners: { codex: { type: codex } }
agents: { worker: { runner: codex, instructions: ./instructions.md } }
checks: {}
labels:
  enrollment: conveyor
  stageTemplate: "conveyor:{stage}"
  states: { done: "conveyor:done", blocked: "conveyor:blocked" }
  metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" }
pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked]
    stages:
      - id: implementation
        run: { agent: worker }
        concurrency: 1
repositories:
  repo: { source: github, address: owner/repo, folder: ${root}/repo, pipeline: default }
`);
  const config = await loadConfig(path.join(root, "config.yml"));
  const store = await ConveyorStore.open(config.settings.database);
  const source: Array<{ id: string; number: number; url: string; title: string; body: string; state: "open"; stateReason: null; labels: string[]; updatedAt: string }> = [];
  const created: Array<{ address: string; title: string; body: string; labels: readonly string[] }> = [];
  const listing: { mode: "normal" | "hang" | "fail" } = { mode: "normal" };
  const github = {
    async createIssue(input: { address: string; title: string; body: string; labels: readonly string[] }) {
      created.push(input);
      const number = source.length + 1;
      const issue = {
        id: `github:${input.address}#${number}`, number, url: `https://github.com/${input.address}/issues/${number}`, title: input.title,
        body: input.body, state: "open" as const, stateReason: null, labels: [...input.labels], updatedAt: "2026-10-07T20:00:00Z",
      };
      source.push(issue);
      return issue;
    },
    async listIssues() {
      if (listing.mode === "hang") return new Promise<never>(() => {});
      if (listing.mode === "fail") throw new Error("forge listing down");
      return source.map((issue) => ({ ...issue }));
    },
    async getIssue(_address: string, number: number) { return { ...source[number - 1]! }; },
    async getIssueProvenance() { return { enrollment: { login: "maintainer" }, title: { login: "maintainer" }, body: { login: "maintainer" } }; },
    async collaboratorPermission() { return "write" as const; },
    async listSubIssues() { return []; },
    async listDependencies() { return []; },
    async upsertStatusComment() { return 1; },
  };
  const service = new ConveyorService(config, store, github as never);
  service.drain("tests: nothing executes");
  stops.push(() => void service.close());
  const token = newOperatorToken();
  const handler = createOperatorMcpHandler({
    facade: { store, status: () => ({}), findItem: () => null, createIssue: (input) => service.createIssue(input), dispatch: (name, input) => service.commands.dispatch(name, input, { kind: "cli", id: null, name: "test", role: "superuser" }) },
    tokenIsActive: (hash) => hash === hashOperatorToken(token),
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  stops.push(() => void server.stop(true));
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(OPERATOR_MCP_PATH, server.url.href), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as Parameters<Client["connect"]>[0]);
  stops.push(() => void client.close());
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: "create_issue", arguments: args });
    return { isError: result.isError === true, text: (result.content as Array<{ text: string }>)[0]!.text };
  };
  return { service, store, config, created, call, client, listing, records };
}

describe("create_issue operator tool", () => {
  test("is listed by the operator MCP endpoint and registered", async () => {
    const { client } = await setup();
    expect(OPERATOR_TOOLS.map((tool) => tool.name)).toContain("create_issue");
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("create_issue");
  });

  test("creates the issue with the given title and body in the named onboarded repository", async () => {
    const { call, created } = await setup();
    const result = await call({ repository: "repo", title: "Add a thing", body: "Details" });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ number: 1, url: "https://github.com/owner/repo/issues/1" });
    expect(created).toEqual([{ address: "owner/repo", title: "Add a thing", body: "Details", labels: ["conveyor"] }]);
    // The source address names the repository as well.
    await call({ repository: "owner/repo", title: "Second", body: "" });
    expect(created.map((issue) => issue.address)).toEqual(["owner/repo", "owner/repo"]);
  });

  test("the created issue is enrolled and appears in the item list at the start stage", async () => {
    const { call, store, service } = await setup();
    await call({ repository: "repo", title: "Add a thing", body: "Details" });
    const board = await createControlHandler(service, {
      home: "/tmp", config: "/tmp/c", logs: "/tmp/l", database: "/tmp/d", dashboardUrl: "http://127.0.0.1:1/", startedAt: "2026-10-06T10:00:00.000Z", supervised: false,
    })(new Request("http://control/v1/board"));
    expect(JSON.stringify(await board.json())).toContain("Add a thing");
    const stored = store.getIssueByNumber("repo", 1);
    expect(stored).toMatchObject({ title: "Add a thing", projectedStage: "implementation" });
    expect(stored?.labels).toContain("conveyor");
  });

  test("returns issueId, number and url while the repository sync never finishes", async () => {
    const { call, listing } = await setup();
    listing.mode = "hang";
    const result = await Promise.race([call({ repository: "repo", title: "Fast", body: "" }), Bun.sleep(3000).then(() => "timeout" as const)]);
    expect(result).not.toBe("timeout");
    expect(JSON.parse((result as { text: string }).text)).toEqual({ issueId: "github:owner/repo#1", number: 1, url: "https://github.com/owner/repo/issues/1" });
  });

  test("the repository sync still runs in the background so the issue appears in the item list", async () => {
    const { call, store } = await setup();
    await call({ repository: "repo", title: "Later", body: "" });
    for (let i = 0; i < 100 && !store.getIssueByNumber("repo", 1); i++) await Bun.sleep(20);
    expect(store.getIssueByNumber("repo", 1)).toMatchObject({ title: "Later" });
  });

  test("a background sync failure is logged and the returned result is unchanged", async () => {
    const { call, listing, records } = await setup();
    listing.mode = "fail";
    const result = await call({ repository: "repo", title: "Fails later", body: "" });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ number: 1 });
    for (let i = 0; i < 100 && !records.some((r) => r.level === "error" && r.repository === "repo"); i++) await Bun.sleep(20);
    expect(records.some((r) => r.level === "error" && r.repository === "repo")).toBe(true);
  });

  test("the same idempotency key and repository returns the first result and creates no second issue", async () => {
    const { call, created } = await setup();
    const first = await call({ repository: "repo", title: "Once", body: "", idempotencyKey: "k1" });
    const retry = await call({ repository: "owner/repo", title: "Once", body: "", idempotencyKey: "k1" });
    expect(retry.isError).toBe(false);
    expect(JSON.parse(retry.text)).toEqual(JSON.parse(first.text));
    expect(created).toHaveLength(1);
  });

  test("concurrent calls with the same key create one issue", async () => {
    const { call, created } = await setup();
    const [a, b] = await Promise.all([call({ repository: "repo", title: "Once", body: "", idempotencyKey: "k" }), call({ repository: "repo", title: "Once", body: "", idempotencyKey: "k" })]);
    expect(JSON.parse(a.text)).toEqual(JSON.parse(b.text));
    expect(created).toHaveLength(1);
  });

  test("different keys, or no key, each create their own issue", async () => {
    const { call, created } = await setup();
    await call({ repository: "repo", title: "A", body: "", idempotencyKey: "k1" });
    await call({ repository: "repo", title: "A", body: "", idempotencyKey: "k2" });
    await call({ repository: "repo", title: "A", body: "" });
    await call({ repository: "repo", title: "A", body: "" });
    expect(created).toHaveLength(4);
  });

  test("logs the duration of each step and the total in one entry per call", async () => {
    const { call, records } = await setup();
    await call({ repository: "repo", title: "Timed", body: "" });
    const entries = records.filter((r) => r.message === "create_issue completed");
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    for (const field of ["forgeCreateMs", "syncHandoffMs", "totalMs"]) expect(typeof entry[field]).toBe("number");
    expect(entry.repository).toBe("repo");
  });

  test("a repository that is not onboarded returns a tool error and creates nothing", async () => {
    const { call, created, store } = await setup();
    const result = await call({ repository: "owner/unknown", title: "Nope", body: "" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not onboarded");
    expect(created).toEqual([]);
    expect(store.getIssueByNumber("repo", 1)).toBeNull();
  });

  test("an empty or blank title returns a tool error and creates nothing", async () => {
    const { call, created } = await setup();
    for (const title of ["", "   "]) {
      const result = await call({ repository: "repo", title, body: "x" });
      expect(result.isError).toBe(true);
    }
    expect(created).toEqual([]);
  });
});

describe("issue creation stays operator-only", () => {
  test("no run-scoped agent MCP tool creates issues", async () => {
    const names = [...registeredToolNames(), ...agentGrantableTools()];
    expect(names.filter((name) => /create[._]?issue/i.test(name))).toEqual([]);
    const context: RunMcpContext = {
      version: 1, runId: "run-1", stageId: "implementation", repository: { id: "repo", address: "owner/repo", baseBranch: "main" },
      issue: { id: "i", number: 1, title: "t", body: "b", labels: [], url: "u" }, workspace: { path: "/w", branch: "b" },
      delivery: { pullRequest: null, checks: [] }, sourceGuidance: "", control: { url: "http://127.0.0.1:1/internal/mcp", token: "t" },
      allowedTools: agentGrantableTools(),
    };
    const control = { async call() { throw new Error("no call expected"); } };
    expect(() => createConveyorMcpServer({ ...context, allowedTools: [...context.allowedTools, "create_issue"] }, control)).toThrow("unsupported MCP tool grant");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createConveyorMcpServer(context, control);
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = (await client.listTools()).tools.map((tool) => tool.name);
    await client.close();
    expect(listed.filter((name) => /create[._]?issue/i.test(name))).toEqual([]);
  });

  test("the control API has no issue-creation route and no command creates an issue", async () => {
    const { service } = await setup();
    const handler = createControlHandler(service, {
      home: "/tmp", config: "/tmp/c", logs: "/tmp/l", database: "/tmp/d", dashboardUrl: "http://127.0.0.1:1/", startedAt: "2026-10-06T10:00:00.000Z", supervised: false,
    });
    for (const route of ["/v1/issues", "/v1/items", "/v1/repositories/repo/issues", "/v1/create-issue"]) {
      for (const method of ["POST", "PUT"]) {
        const response = await handler(new Request(`http://control${route}`, { method, body: JSON.stringify({ repository: "repo", title: "x", body: "" }) }));
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
    }
    expect(Object.keys(COMMANDS).filter((name) => /issue/i.test(name))).toEqual([]);
  });
});
