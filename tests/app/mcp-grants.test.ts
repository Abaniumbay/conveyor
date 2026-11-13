import { afterEach, describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { McpGrants } from "../../src/app/mcp-grants";
import type { TaskDeps } from "../../src/tasks/deps";
import { log, type LogRecord } from "../../src/log/logger";
import { itemWorld, type ItemWorld } from "../support/item-world";

let opened: ItemWorld | null = null;
afterEach(async () => { await opened?.close(); opened = null; });

type ContextFile = {
  runId: string;
  stageId: string;
  repository: { id: string; address: string };
  issue: { id: string; number: number; url: string };
  workspace: { path: string; branch: string } | null;
  control: { url: string; token: string };
  allowedTools: string[];
};

async function setup() {
  const world = await itemWorld();
  opened = world;
  const records: LogRecord[] = [];
  log.configure({ sinks: [{ write: (record) => { records.push(record); } }] });
  const calls = { boards: [] as string[], issueDeps: [] as string[], statusComments: [] as string[] };
  const grants = new McpGrants({
    config: world.config,
    store: world.store,
    issueTaskDeps: (issueId): TaskDeps => {
      calls.issueDeps.push(issueId);
      throw new Error("these tests call no item tool");
    },
    operatorTools: (runId, stopSummary) => ({
      scheduled: false,
      ...(stopSummary ? { stopSummary } : {}),
      board: () => { calls.boards.push(runId); return { items: [], runId }; },
      findItem: (reference) => ({ reference, status: "not-on-board", items: [] }),
      itemHistory: () => ({}),
      retry: async () => ({ status: "queued", stageId: "implementation" }),
      moveBacklog: () => ({}),
    }),
    forgetChange: () => {},
    loadDeliveryState: async () => ({ change: null, pullRequest: null, checks: [] }),
    updateStatusComment: async (issueId) => { calls.statusComments.push(issueId); },
    itemFields: (issueId) => ({ item: issueId }),
  });
  const contextOf = async (args: readonly string[]) => {
    const file = args[args.indexOf("--context") + 1]!;
    return { file, context: JSON.parse(await readFile(file, "utf8")) as ContextFile };
  };
  return { world, grants, calls, records, contextOf };
}

describe("an item-scoped grant", () => {
  test("writes the run's scope and canonical tools to a private file that its lease removes", async () => {
    const { world, grants, contextOf } = await setup();
    world.items.add(1, ["conveyor", "conveyor:implementation"]);
    const issue = world.store.getIssue(world.seed(1, { stage: "implementation", state: "active" }))!;
    const lease = await grants.factory().create({
      runId: "run-1",
      stageId: "implementation",
      context: {
        issue,
        repository: { id: "repo", address: "owner/my-app", folder: world.root, baseBranch: "main" },
        workspace: { path: world.root, branch: "conveyor/1" },
        sourceGuidance: "Guidance.",
      },
      allowedTools: ["run.report_progress", "agent.reportProgress"],
      actor: { id: "worker", name: "Worker", title: "Implementer" },
    });
    const { file, context } = await contextOf(lease.configuration.args);
    expect(file).toBe(path.join(world.config.settings.artifacts, "run-1", "mcp-context.json"));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(context).toMatchObject({
      runId: "run-1",
      stageId: "implementation",
      repository: { id: "repo", address: "owner/my-app" },
      issue: { id: issue.id, number: 1, url: issue.sourceUrl },
      workspace: { path: world.root, branch: "conveyor/1" },
      control: { url: "http://127.0.0.1:7788/internal/mcp" },
      allowedTools: ["agent.reportProgress"],
    });

    await lease.close();
    expect(await Bun.file(file).exists()).toBe(false);
    await expect(grants.handle({ tool: "agent.reportProgress", input: {} }, context.control.token)).rejects.toThrow("expired MCP grant");
  });

  test("refuses a tool outside the grant and logs it for the item", async () => {
    const { world, grants, records, contextOf } = await setup();
    world.items.add(1, ["conveyor", "conveyor:implementation"]);
    const issue = world.store.getIssue(world.seed(1, { stage: "implementation", state: "active" }))!;
    const lease = await grants.factory().create({
      runId: "run-1", stageId: "implementation",
      context: { issue, repository: { id: "repo", address: "owner/my-app", folder: world.root, baseBranch: "main" }, workspace: null, sourceGuidance: "" },
      allowedTools: ["agent.reportProgress"],
      actor: { id: "worker", name: "Worker", title: "Implementer" },
    });
    const { context } = await contextOf(lease.configuration.args);
    await expect(grants.handle({ tool: "operator.getBoard", input: {} }, context.control.token)).rejects.toThrow("MCP tool is not granted: operator.getBoard");
    await expect(grants.handle({ input: {} }, context.control.token)).rejects.toThrow("tool must be a non-empty string");
    expect(records.filter((record) => record.message === "Issue MCP tool failed")).toEqual([
      expect.objectContaining({ item: issue.id, tool: "operator.getBoard" }),
      expect.objectContaining({ item: issue.id, tool: "unknown" }),
    ]);
    await lease.close();
  });
});

describe("the run's tool guidance", () => {
  test("carries the harness's own lines for the canonical grant, and none without them", async () => {
    const { world, grants, contextOf } = await setup();
    const guided = await grants.steeringLease("steer-1", world.root, ["operator.getBoard", "operator.getBoard"], {
      toolNameGuidance: (names) => names.map((name) => `call ${name}`),
    });
    expect((await contextOf(guided.configuration.args)).context).toMatchObject({ harnessToolGuidance: ["call operator.getBoard"] });
    await guided.close();
    const plain = await grants.steeringLease("steer-2", world.root, ["operator.getBoard"]);
    expect((await contextOf(plain.configuration.args)).context).toMatchObject({ harnessToolGuidance: [] });
    await plain.close();
  });
});

describe("a system-scoped grant", () => {
  test("names no item and gives its tools the run's Operator tools", async () => {
    const { world, grants, calls, contextOf } = await setup();
    const lease = await grants.steeringLease("steer-1", world.root, ["operator.getBoard"]);
    const { context } = await contextOf(lease.configuration.args);
    expect(context).toMatchObject({
      stageId: "steering",
      repository: { id: "conveyor-system", address: "conveyor/system" },
      issue: { id: "steering:steer-1", url: "http://127.0.0.1:7788/" },
      workspace: { path: world.root, branch: "steering" },
      allowedTools: ["operator.getBoard"],
    });
    const result = await grants.handle({ tool: "operator.getBoard", input: { runId: "ignored" } }, context.control.token);
    expect(JSON.stringify(result)).toContain("steer-1");
    expect(calls.boards).toEqual(["steer-1"]);
    expect(calls.issueDeps).toEqual([]);
    await lease.close();
  });

  test("answers a retried call from its first response", async () => {
    const { world, grants, calls, contextOf } = await setup();
    const lease = await grants.steeringLease("steer-1", world.root, ["operator.getBoard"]);
    const { context } = await contextOf(lease.configuration.args);
    const first = await grants.handle({ tool: "operator.getBoard", input: {} }, context.control.token, "call-1");
    const retried = await grants.handle({ tool: "operator.getBoard", input: {} }, context.control.token, "call-1");
    expect(retried).toBe(first);
    expect(calls.boards).toEqual(["steer-1"]);
    await lease.close();
  });

  test("refuses an item tool, which needs an item-scoped grant", async () => {
    const { world, grants, contextOf } = await setup();
    const lease = await grants.steeringLease("steer-1", world.root, ["item.get"]);
    const { context } = await contextOf(lease.configuration.args);
    await expect(grants.handle({ tool: "item.get", input: {} }, context.control.token)).rejects.toThrow("requires an issue-scoped MCP grant");
    await lease.close();
  });
});
