import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import type { Harness, HarnessRunInput } from "../../src/harness/types";
import { ReviewFindings } from "../../src/engine/review-findings";
import { ItemTodos } from "../../src/engine/todos";
import { EMPTY_USAGE, UNAVAILABLE_COST, type RunEnvelope } from "../../src/runner/result";
import { createTaskRegistry } from "../../src/tasks/catalogue";
import type { HarnessResumeInput, TaskContext } from "../../src/tasks/context";
import { runTask, type TaskResult } from "../../src/tasks/contract";
import type { TaskDeps } from "../../src/tasks/deps";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const registry = createTaskRegistry();
type Call = HarnessRunInput & HarnessResumeInput;
type Behaviour = (call: Call, runId: string, store: ConveyorStore) => Partial<RunEnvelope["stageResult"]> & { sessionId?: string | null };

let usage: RunEnvelope["usage"] = { ...EMPTY_USAGE };
const envelope = (over: ReturnType<Behaviour>): RunEnvelope => ({
  stageResult: { outcome: "success", status: "done", summary: "All done", reason: null, metrics: {}, ...over },
  sessionId: over.sessionId === undefined ? "sess-1" : over.sessionId,
  usage: { ...usage }, cost: { ...UNAVAILABLE_COST }, durationMs: 5, exitCode: 0, artifacts: [], stderr: "",
});

async function world(options: { sessionResume?: boolean; noWorkspace?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-agent-"));
  directories.push(root);
  const store = await ConveyorStore.open(path.join(root, "db.sqlite"));
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "o/r", folder: "/f", configHash: "h" });
  store.upsertIssue({
    id: "i1", repositoryId: "repo", sourceNumber: 7, sourceUrl: "https://x/7", title: "Fix it", body: "Body",
    sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  const enrollment = store.activateEnrollment("i1");
  const workspace = path.join(root, "ws");
  await mkdir(workspace);
  if (!options.noWorkspace) store.recordWorkspace({ id: "w1", enrollmentId: enrollment.id, path: workspace, branch: "conveyor/7", status: "active" });
  const managerCalls: Array<{ op: string; input: Record<string, unknown> }> = [];
  const workspaces = {
    create: async (input: Record<string, unknown>) => {
      managerCalls.push({ op: "create", input });
      const created = path.join(root, "created");
      await mkdir(created, { recursive: true });
      return { path: created, branch: "conveyor/7-fix-it" };
    },
    restore: async (input: Record<string, unknown>) => { managerCalls.push({ op: "restore", input }); await mkdir(input.workspacePath as string, { recursive: true }); },
    remove: async () => {},
  };
  const instructions = path.join(root, "kaveh.md");
  await writeFile(instructions, "You are Kaveh.");
  const config = {
    hash: "cfg",
    settings: { artifacts: path.join(root, "artifacts"), interruptGraceMs: 100, agentRunTokenWarning: 15_000_000 },
    agents: {
      kaveh: { runner: "codex", instructions, tasks: ["agent.reportProgress"], name: "Kaveh", title: "Implementer", workspaceAccess: "write" },
      shirin: { runner: "codex", instructions, tasks: ["agent.reportProgress"], name: "Shirin", title: "Reviewer", workspaceAccess: "read-only" },
    },
    runners: { codex: { type: "codex", command: "codex", sandbox: "workspace-write", automaticApprovals: true } },
  } as unknown as ConveyorConfig;

  const calls: Call[] = [];
  const leases: Array<{ runId: string; allowedTools: readonly string[]; closed: boolean }> = [];
  let behaviour: Behaviour = () => ({});
  const harness: Harness = {
    id: "fake",
    capabilities: { sessionResume: options.sessionResume ?? true },
    async run(input) {
      calls.push(input);
      return envelope(behaviour(input, leases.at(-1)!.runId, store));
    },
  };
  const controller = new AbortController();
  const deps = {
    store, config, items: {} as never, git: {} as never, workspaces,
    repository: { id: "repo", address: "o/r", folder: "/f", baseBranch: "main" },
    issueId: "i1", sourceGuidance: "GUIDE", signal: controller.signal,
    harnesses: { codex: harness },
    delivery: async () => ({ pullRequest: null, checks: [] }),
    mcp: {
      create: async (input: { runId: string; allowedTools: readonly string[] }) => {
        const lease = { runId: input.runId, allowedTools: input.allowedTools, closed: false };
        leases.push(lease);
        return { configuration: { command: "bun", args: ["mcp"] }, close: () => { lease.closed = true; } };
      },
    },
  } as unknown as TaskDeps;
  const context = { run: { stage: "implementation", attempt: 1, feedback: null, taskInstanceId: "implement" } } as unknown as Partial<TaskContext>;
  const run = (resumed: boolean, config: unknown = { agent: "kaveh" }) =>
    runTask(registry.require("agent.run"), {
      context, deps, config,
      instance: { id: "implement", stage: "implementation", idempotencyKey: "key-1", resumed },
    });
  return { store, run, context, deps, calls, leases, controller, managerCalls, root, setBehaviour: (b: Behaviour) => { behaviour = b; } };
}
type World = Awaited<ReturnType<typeof world>>;

const asks = (prompt: string): Behaviour => (_call, runId, store) => {
  store.openQuestion({ issueId: "i1", runId, prompt, reason: "need it", options: [] });
  return { outcome: "failure", status: "needs-input", summary: "Asked", reason: prompt, sessionId: "sess-1" };
};
const outcome = (result: TaskResult) => (result as Extract<TaskResult, { status: "pass" }>).output as Record<string, unknown>;
const stripRun = ({ runId: _r, sessionId: _s, ...rest }: Record<string, unknown>) => rest;
const answer = (w: World, text: string) => {
  const question = w.store.listOpenQuestions()[0]!;
  w.store.answerQuestion(question.id, "web", { answer: text });
  return question;
};

describe("agent.run", () => {
  test("runs the next listed agent when the first one's harness cannot run, and says so", async () => {
    const w = await world();
    w.deps.config.agents.kaveh!.tasks = ["workspace.push"];
    w.deps.config.agents.shirin!.tasks = ["conversation.get"];
    let calls = 0;
    w.setBehaviour(() => {
      if (++calls === 1) throw Object.assign(new Error("Claude usage limit reached"), { kind: "usage-limit" });
      return {};
    });
    const result = await w.run(false, { agents: ["kaveh", "shirin"] });
    expect(result.status).toBe("pass");
    expect(outcome(result)).toMatchObject({ agentId: "shirin", status: "done" });
    expect(w.calls[0]!.prompt).toContain("workspace.push → tools.mcp__conveyor__workspace_push");
    expect(w.calls[1]!.prompt).toContain("conversation.get → tools.mcp__conveyor__conversation_get");
    expect(w.calls[1]!.prompt).not.toContain("tools.mcp__conveyor__workspace_push");
    expect(w.leases[1]!.allowedTools).toEqual(["conversation.get"]);
    const notes = w.store.listConversationMessages("i1", 100).filter((message) => message.actorName === "Conveyor").map((message) => message.message);
    expect(notes).toEqual(["Kaveh could not run (Claude usage limit reached); Shirin takes this implementation instead."]);
  });

  test("puts the same handover in every prompt: fresh, fallback and resumed, keeping the issue when todos are huge", async () => {
    const w = await world();
    new ItemTodos(w.store.sqlite()).set("i1", Array.from({ length: 80 }, (_, i) => ({ id: `t${i}`, text: "x".repeat(200), status: "pending" as const })), null, "2026-01-01T00:00:00Z");
    let calls = 0;
    w.setBehaviour((_call, runId, store) => {
      if (++calls === 1) throw Object.assign(new Error("usage limit"), { kind: "usage-limit" });
      if (calls === 2) return asks("Which?")(_call, runId, store);
      return {};
    });
    await w.run(false, { agents: ["kaveh", "shirin"] });
    answer(w, "this");
    await w.run(true, { agents: ["kaveh", "shirin"] });
    const handovers = w.calls.map((call) => /"handover": \{[\s\S]*?\n  \}/.exec(call.prompt)?.[0]);
    for (const call of w.calls) expect(call.prompt).toContain('"handover"');
    expect(w.calls[1]!.prompt).toContain("The previous run on this stage was by Kaveh, not by you (Shirin)");
    expect(w.calls[1]!.prompt).toContain('"fullState": "todo.get"');
    expect(w.calls[1]!.prompt).toContain('"title": "Fix it"');
    expect(handovers.every(Boolean)).toBe(true);
    expect(w.calls.at(-1)!.prompt).toContain("Which?");
  });

  test("does not fall back when the run was interrupted, or when the last agent fails", async () => {
    const w = await world();
    w.setBehaviour(() => { throw Object.assign(new Error("stopped"), { kind: "interrupted" }); });
    await expect(w.run(false, { agents: ["kaveh", "shirin"] })).rejects.toThrow("stopped");
    expect(w.calls).toHaveLength(1);
    w.setBehaviour(() => { throw new Error("broken"); });
    await expect(w.run(false, { agents: ["kaveh", "shirin"] })).rejects.toThrow("broken");
    expect(w.calls).toHaveLength(3);
  });

  test("takes exactly one of agent or agents", () => {
    const schema = registry.require("agent.run").config!;
    expect(schema.safeParse({ agent: "kaveh" }).success).toBe(true);
    expect(schema.safeParse({ agents: ["kaveh", "shirin"] }).success).toBe(true);
    expect(schema.safeParse({ agent: "kaveh", agents: ["shirin"] }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ agents: [] }).success).toBe(false);
  });

  test("warns in the conversation when a run passes the token budget, without stopping it", async () => {
    const w = await world();
    usage = { ...EMPTY_USAGE, inputTokens: 39_600_000 };
    try {
      expect((await w.run(false)).status).toBe("pass");
    } finally {
      usage = { ...EMPTY_USAGE };
    }
    const warnings = w.store.listConversationMessages("i1", 100).filter((message) => message.actorName === "Conveyor");
    expect(warnings.map((message) => message.message)).toEqual([
      "Kaveh's run used 39.6M input tokens, over the 15M budget. It was not stopped. A run this large usually means the item is too big or coupled with other work; consider refining it.",
    ]);
    const second = await world();
    await second.run(false);
    expect(second.store.listConversationMessages("i1", 100).filter((message) => message.actorName === "Conveyor")).toEqual([]);
  });

  test("skips the agent when the only feedback is a failure the stage's own actions repair", async () => {
    const w = await world();
    (w.context.run as { feedback: unknown }).feedback = {
      from: { stage: "implementation", taskInstanceId: "criteriaSynced" }, message: "checklist out of sync", repairedByActions: true,
    };
    expect(await w.run(false)).toEqual({ status: "pass" });
    expect(w.calls).toHaveLength(0);
  });

  test("ensures the workspace itself when none is recorded and invalidates the workspace context", async () => {
    const w = await world({ noWorkspace: true });
    expect(registry.require("agent.run").invalidates).toContain("workspace");
    const result = await w.run(false);
    expect(result.status).toBe("pass");
    expect(w.managerCalls.map((c) => c.op)).toEqual(["create"]);
    const stored = w.store.getActiveWorkspace("i1")!;
    expect(stored.branch).toBe("conveyor/7-fix-it");
    expect(w.calls[0]!.workspace).toBe(stored.path);
  });

  test("restores the recorded workspace when its directory is missing", async () => {
    const w = await world();
    await rm(w.store.getActiveWorkspace("i1")!.path, { recursive: true, force: true });
    const result = await w.run(false);
    expect(result.status).toBe("pass");
    expect(w.managerCalls.map((c) => c.op)).toEqual(["restore"]);
    expect(w.managerCalls[0]!.input).toMatchObject({ workspacePath: w.store.getActiveWorkspace("i1")!.path, branch: "conveyor/7", baseBranch: "main" });
  });

  test("runs the agent through the harness, records the run and captures the result", async () => {
    const w = await world();
    w.setBehaviour(() => ({ summary: "Implemented", sessionId: "sess-9" }));
    const result = await w.run(false);
    expect(result.status).toBe("pass");
    const call = w.calls[0]!;
    expect(call).toMatchObject({ command: "codex", workspace: path.join(w.store.getActiveWorkspace("i1")!.path), sandbox: "workspace-write", automaticApprovals: true });
    expect(call.prompt).toContain("You are Kaveh.");
    expect(call.prompt).toContain('"stageId": "implementation"');
    expect(call.prompt).toContain("agent.reportProgress → tools.mcp__conveyor__agent_reportProgress");
    expect(call.prompt).toContain("Do not invent status names such as blocked-external");
    expect(call.mcp).toEqual({ command: "bun", args: ["mcp"] });
    expect(call.resumeSessionId).toBeUndefined();
    expect(w.leases).toEqual([{ runId: expect.any(String), allowedTools: ["agent.reportProgress"], closed: true }]);
    const runId = w.leases[0]!.runId;
    expect(outcome(result)).toEqual({ agentId: "kaveh", status: "done", summary: "Implemented", reason: null, sessionId: "sess-9", runId });
    expect(w.store.getRun(runId)).toMatchObject({ status: "succeeded", sessionId: "sess-9", kind: "producer", stageId: "implementation" });
    expect(w.store.listConversationMessages("i1").map((m) => [m.actorType, m.message])).toEqual([["agent", "Implementation completed: Implemented."]]);
  });

  test("a workspace-write agent may write its worktree's git metadata and its existing extra roots, with network when enabled", async () => {
    const w = await world();
    const workspace = w.store.getActiveWorkspace("i1")!.path;
    await mkdir(workspace, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: workspace });
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: workspace });
    const cache = path.join(w.root, "cache");
    await mkdir(cache);
    Object.assign(w.deps.config.agents.kaveh!, { network: true, writableRoots: [cache, path.join(w.root, "missing")] });
    expect((await w.run(false)).status).toBe("pass");
    const git = path.join(workspace, ".git");
    expect(w.calls[0]).toMatchObject({ network: true, writableRoots: [git, ...["objects", "refs", "logs"].map((d) => path.join(git, d)), cache] });
  });

  test("an agent's codexConfig and MCP servers reach the harness, and their files are git-excluded first", async () => {
    const w = await world();
    const workspace = w.store.getActiveWorkspace("i1")!.path;
    await mkdir(workspace, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: workspace });
    Object.assign(w.deps.config.agents.kaveh!, {
      codexConfig: { model_auto_compact_token_limit: 80000 },
      mcpServers: { serena: { command: "serena", args: ["start-mcp-server", "--project", "{workspace}"], env: { SERENA_HOME: "/s" }, startupTimeoutSec: 60, enabledTools: ["find_symbol"], gitExclude: [".serena/"] } },
    });
    expect((await w.run(false)).status).toBe("pass");
    expect(w.calls[0]).toMatchObject({
      config: { model_auto_compact_token_limit: 80000 },
      mcpServers: { serena: { command: "serena", args: ["start-mcp-server", "--project", workspace], env: { SERENA_HOME: "/s" }, startupTimeoutSec: 60, enabledTools: ["find_symbol"] } },
    });
    expect(w.calls[0]!.mcpServers!.serena).not.toHaveProperty("gitExclude");
    expect(await Bun.file(path.join(workspace, ".git", "info", "exclude")).text()).toContain(".serena/\n");
  });

  test("an agent without extensions passes no config or MCP servers", async () => {
    const w = await world();
    expect((await w.run(false)).status).toBe("pass");
    expect(w.calls[0]!.config).toBeUndefined();
    expect(w.calls[0]!.mcpServers).toBeUndefined();
  });

  test("a workspace-write Claude Code agent gets its worktree, roots and MCP servers, but no Codex settings", async () => {
    const w = await world();
    const workspace = w.store.getActiveWorkspace("i1")!.path;
    await mkdir(workspace, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: workspace });
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: workspace });
    const cache = path.join(w.root, "cache");
    await mkdir(cache);
    const config = w.deps.config as unknown as { runners: Record<string, unknown>; agents: Record<string, unknown> };
    config.runners.claude = { type: "claude-code", command: "claude" };
    config.agents.jamshid = {
      ...config.agents.kaveh as object, name: "Jamshid", runner: "claude", workspaceAccess: "workspace-write", network: true, writableRoots: [cache],
      codexConfig: { model_auto_compact_token_limit: 1 },
      mcpServers: { serena: { command: "serena", args: ["--project", "{workspace}"], env: {}, enabledTools: ["find_symbol"], gitExclude: [".serena/"] } },
    };
    const harnesses = w.deps.harnesses as Record<string, unknown>;
    harnesses["claude-code"] = harnesses.codex;
    expect((await w.run(false, { agent: "jamshid" })).status).toBe("pass");
    const git = path.join(workspace, ".git");
    expect(w.calls[0]).toMatchObject({
      command: "claude", sandbox: "workspace-write", automaticApprovals: false, network: true,
      writableRoots: [git, ...["objects", "refs", "logs"].map((d) => path.join(git, d)), cache],
      mcpServers: { serena: { command: "serena", args: ["--project", workspace], env: {}, enabledTools: ["find_symbol"] } },
    });
    expect(w.calls[0]!.config).toBeUndefined();
    expect(await Bun.file(path.join(git, "info", "exclude")).text()).toContain(".serena/");
  });

  test("a read-only agent gets network (web search) but no writable roots", async () => {
    const w = await world();
    Object.assign(w.deps.config.agents.shirin!, { network: true, writableRoots: [w.root] });
    expect((await w.run(false, { agent: "shirin" })).status).toBe("pass");
    expect(w.calls[0]!.sandbox).toBe("read-only");
    expect(w.calls[0]!.network).toBe(true);
    expect(w.calls[0]!.writableRoots).toBeUndefined();
  });

  test("an agent without network gets none", async () => {
    const w = await world();
    expect((await w.run(false)).status).toBe("pass");
    expect(w.calls[0]!.network).toBeUndefined();
  });

  test("passes the run's abort signal to the harness", async () => {
    const w = await world();
    w.setBehaviour((call) => { expect(call.signal).toBeDefined(); return {}; });
    await w.run(false);
    expect(w.calls[0]!.signal).toBe(w.controller.signal);
    w.controller.abort();
    expect(w.calls[0]!.signal?.aborted).toBe(true);
  });

  test("a question parks the action and records what is needed to resume", async () => {
    const w = await world();
    w.setBehaviour(asks("Which database?"));
    const result = await w.run(false);
    expect(result).toEqual({ status: "pending", message: "Waiting for an answer: Which database?" });
    expect(w.leases[0]!.closed).toBe(true);
    expect(w.store.listRunsForExecution("i1", "implementation", "producer", "key-1")[0]).toMatchObject({ status: "succeeded", sessionId: "sess-1" });
  });

  test("a question answered before the run returned is continued on the next poll", async () => {
    const w = await world();
    w.setBehaviour((call, runId, store) => {
      const result = asks("Which database?")(call, runId, store);
      store.answerQuestion(store.listOpenQuestions()[0]!.id, "web", { answer: "SQLite" });
      return result;
    });
    expect(await w.run(false)).toEqual({ status: "pending", message: "Waiting for an answer: Which database?", after: 0 });
    w.setBehaviour(() => ({ summary: "Used SQLite" }));
    expect((await w.run(true)).status).toBe("pass");
    expect(w.calls[1]!.answeredQuestion).toEqual({ question: "Which database?", answer: "SQLite" });
  });

  test("an open question stays pending without running the harness again", async () => {
    const w = await world();
    w.setBehaviour(asks("Which database?"));
    await w.run(false);
    const again = await w.run(true);
    expect(again).toEqual({ status: "pending", message: "Waiting for an answer: Which database?" });
    expect(w.calls).toHaveLength(1);
    expect(w.leases).toHaveLength(1);
  });

  test("a resume-capable and an incapable harness produce the same outcome once the question is answered", async () => {
    const outcomes: Array<Record<string, unknown>> = [];
    const finalCalls: Call[] = [];
    for (const sessionResume of [true, false]) {
      const w = await world({ sessionResume });
      w.setBehaviour(asks("Which database?"));
      await w.run(false);
      answer(w, "PostgreSQL");
      w.deps.config.agents.kaveh!.tasks = ["conversation.get"];
      w.setBehaviour(() => ({ summary: "Used PostgreSQL" }));
      const result = await w.run(true);
      expect(result.status).toBe("pass");
      outcomes.push(stripRun(outcome(result)));
      finalCalls.push(w.calls[1]!);
      expect(w.calls).toHaveLength(2);
      expect(w.calls[1]!.prompt).toContain("conversation.get → tools.mcp__conveyor__conversation_get");
      expect(w.calls[1]!.prompt).not.toContain("tools.mcp__conveyor__agent_reportProgress");
      expect(w.calls[1]!.prompt).toContain("Do not invent status names such as blocked-external");
    }
    expect(outcomes[0]).toEqual(outcomes[1]!);
    expect(outcomes[0]).toEqual({ agentId: "kaveh", status: "done", summary: "Used PostgreSQL", reason: null });

    const [resumed, fresh] = finalCalls as [Call, Call];
    expect(resumed.resumeSessionId).toBe("sess-1");
    expect(resumed.answeredQuestion).toEqual({ question: "Which database?", answer: "PostgreSQL" });
    expect(resumed.prompt).toContain("PostgreSQL");
    expect(fresh.resumeSessionId).toBeUndefined();
    expect(fresh.answeredQuestion).toBeUndefined();
    expect(fresh.prompt).toContain("You are Kaveh.");
    expect(fresh.prompt).toContain("Which database?");
    expect(fresh.prompt).toContain("PostgreSQL");
  });

  test("a capable harness without a recorded session gets a fresh attempt with the answer", async () => {
    const w = await world({ sessionResume: true });
    w.setBehaviour((_c, runId, store) => {
      store.openQuestion({ issueId: "i1", runId, prompt: "Which?", reason: "r", options: [] });
      return { outcome: "failure", status: "needs-input", summary: "Asked", reason: "Which?", sessionId: null };
    });
    await w.run(false);
    answer(w, "A");
    w.setBehaviour(() => ({}));
    expect((await w.run(true)).status).toBe("pass");
    expect(w.calls[1]!.resumeSessionId).toBeUndefined();
    expect(w.calls[1]!.prompt).toContain("Which?");
  });

  test("a crash during the resumed run keeps the answer for the next attempt", async () => {
    const w = await world({ sessionResume: false });
    w.setBehaviour(asks("Which database?"));
    await w.run(false);
    answer(w, "PostgreSQL");
    w.setBehaviour(() => { throw new Error("crashed"); });
    await expect(w.run(true)).rejects.toThrow("crashed");
    w.setBehaviour(() => ({ summary: "Used PostgreSQL" }));
    expect((await w.run(true)).status).toBe("pass");
    expect(w.calls[2]!.prompt).toContain("Which database?");
    expect(w.calls[2]!.prompt).toContain("PostgreSQL");
  });

  test("an answered question from another execution of the stage is not picked up", async () => {
    const w = await world();
    w.setBehaviour(asks("Old question?"));
    await w.run(false);
    answer(w, "old answer");
    w.setBehaviour(() => ({}));
    // A later visit of the same stage: a different execution key, resumed after a crash before any run.
    const other = await runTask(registry.require("agent.run"), {
      context: {}, config: { agent: "kaveh" }, deps: w.deps,
      instance: { id: "implement", stage: "implementation", idempotencyKey: "key-2", resumed: true },
    });
    expect(other.status).toBe("pass");
    expect(w.calls[1]!.resumeSessionId).toBeUndefined();
    expect(w.calls[1]!.prompt).not.toContain("old answer");
  });

  test("a resumed execution that never asked a question runs a fresh attempt", async () => {
    const w = await world();
    w.setBehaviour(() => ({}));
    expect((await w.run(true)).status).toBe("pass");
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.prompt).not.toContain("answered");
  });

  test.each([
    ["blocked", "Cannot reach the registry"],
    ["rejected", "Out of scope"],
  ])("%s stops with the agent's reason", async (status, reason) => {
    const w = await world();
    w.setBehaviour(() => ({ outcome: "failure", status, summary: "No go", reason }));
    expect(await w.run(false)).toEqual({ status: "fail", message: reason, route: { stop: status } });
    expect(w.calls[0]!.prompt).toContain("name the concrete blocker, the evidence that established it, and the exact action");
    expect(w.store.listConversationMessages("i1").at(-1)?.message).toBe(
      `Implementation stopped as ${status}.\n\n**Why:** ${reason}.\n\n**Summary:** No go.`,
    );
  });

  test("changes-requested with a finding recorded in the run passes so the gates decide", async () => {
    const w = await world();
    w.setBehaviour((_call, runId, store) => {
      new ReviewFindings(store.sqlite()).create({ issueId: "i1", runId, author: "kaveh", headSha: "h1", body: "Rename this" });
      return { outcome: "failure", status: "changes-requested", summary: "Needs work", reason: "see findings" };
    });
    const result = await w.run(false);
    expect(result.status).toBe("pass");
    expect(outcome(result)).toMatchObject({ status: "changes-requested", reason: "see findings" });
  });

  test.each(["earlier-agent", "imported"] as const)("changes-requested reuses an open %s finding without creating a duplicate", async (source) => {
    const w = await world();
    const findings = new ReviewFindings(w.store.sqlite());
    if (source === "earlier-agent") {
      findings.create({ issueId: "i1", runId: "earlier", author: "reviewer", headSha: "older-head", body: "Still needs fixing" });
    } else {
      findings.importNative("i1", [{ providerKey: "thread:1", author: "review-bot", body: "Still needs fixing", url: "https://x/7#review", path: null, line: null, resolved: false }], "older-head", "2026-01-01T00:00:00Z");
    }
    const original = findings.list("i1")[0]!;
    for (const outcome of ["failure", "success"] as const) {
      w.setBehaviour(() => ({ outcome, status: "changes-requested", summary: `Needs work: ${original.id}`, reason: outcome === "failure" ? "see existing finding" : null }));
      expect((await w.run(false)).status).toBe("pass");
      expect(findings.list("i1").map((finding) => finding.id)).toEqual([original.id]);
    }
    expect(w.calls[0]!.prompt).toContain("do not create duplicate findings");
  });

  test("changes-requested with no finding is an error stop", async () => {
    const w = await world();
    w.setBehaviour(() => ({ outcome: "failure", status: "changes-requested", summary: "Needs work", reason: "no evidence" }));
    expect(await w.run(false)).toEqual({
      status: "fail", message: "Reviewer requested changes without an open finding for this item", route: { stop: "error" },
    });
  });

  test.each(["resolved", "dismissed", "withdrawn"] as const)("changes-requested cannot reuse a %s finding", async (state) => {
    const w = await world();
    const findings = new ReviewFindings(w.store.sqlite());
    findings.importNative("i1", [{ providerKey: "thread:1", author: "reviewer", body: "Old finding", url: "https://x/7#review", path: null, line: null, resolved: false }], "older-head", "2026-01-01T00:00:00Z");
    const finding = findings.list("i1")[0]!;
    if (state === "resolved") findings.resolve("i1", finding.id, "reviewer");
    else if (state === "dismissed") findings.dismiss("i1", finding.id, { actor: "owner", reason: "does not apply", at: "2026-01-02T00:00:00Z" });
    else findings.importNative("i1", [], "current-head", "2026-01-02T00:00:00Z");
    expect(findings.get("i1", finding.id)?.state).toBe(state);
    w.setBehaviour(() => ({ outcome: "failure", status: "changes-requested", summary: "Needs work", reason: "old finding" }));
    expect(await w.run(false)).toMatchObject({ status: "fail", route: { stop: "error" } });
  });

  test("an open finding for another item does not justify changes-requested even when created by this run", async () => {
    const w = await world();
    w.store.upsertIssue({ id: "other", repositoryId: "repo", sourceNumber: 8, sourceUrl: "https://x/8", title: "Other item", body: "", sourceState: "open", labels: [], sourceUpdatedAt: "2026-01-01T00:00:00Z" });
    w.setBehaviour((_call, runId, store) => {
      new ReviewFindings(store.sqlite()).create({ issueId: "other", runId, author: "reviewer", headSha: "head", body: "Other item defect" });
      return { outcome: "failure", status: "changes-requested", summary: "Needs work", reason: "unrelated finding" };
    });
    expect(await w.run(false)).toMatchObject({ status: "fail", route: { stop: "error" } });
  });

  test("an unknown failure status is an actionable invalid result", async () => {
    const w = await world();
    w.setBehaviour(() => ({ outcome: "failure", status: "blocked-external", summary: "Hm", reason: "because" }));
    const result = await w.run(false) as Extract<TaskResult, { status: "fail" }>;
    expect(result.route).toEqual({ stop: "error" });
    expect(result.message).toContain("Agent returned an invalid result");
    expect(result.message).toContain("blocked-external");
  });

  test("needs-input without an open question is an actionable invalid result", async () => {
    const w = await world();
    w.setBehaviour(() => ({ outcome: "failure", status: "needs-input", summary: "Hm", reason: "?" }));
    const result = await w.run(false) as Extract<TaskResult, { status: "fail" }>;
    expect(result.route).toEqual({ stop: "error" });
    expect(result.message).toContain("Agent returned an invalid result");
    expect(result.message).toContain("question");
  });

  test("a harness failure marks the run failed, closes the lease and propagates", async () => {
    const w = await world();
    w.setBehaviour(() => { throw new Error("codex crashed"); });
    await expect(w.run(false)).rejects.toThrow("codex crashed");
    expect(w.leases[0]!.closed).toBe(true);
    expect(w.store.getRun(w.leases[0]!.runId)?.status).toBe("failed");
  });

  test("requires a configured agent", async () => {
    const w = await world();
    await expect(w.run(false, { agent: "nobody" })).rejects.toThrow("unknown agent: nobody");
    await expect(w.run(false, {})).rejects.toThrow();
  });
});

describe("agent tools", () => {
  const tool = (w: World, name: string, input: unknown, run: { id: string; actor: { id: string; name: string; title: string } | null } | undefined) =>
    runTask(registry.require(name), {
      context: {}, config: {}, deps: { store: w.store, config: {}, issueId: "i1", ...(run ? { run } : {}) } as unknown as TaskDeps, input,
      instance: { id: name, stage: "implementation", idempotencyKey: "k", resumed: false },
    });
  const actor = { id: "kaveh", name: "Kaveh", title: "Implementer" };

  async function withRun() {
    const w = await world();
    w.setBehaviour(() => ({}));
    await w.run(false);
    return { w, run: { id: w.leases[0]!.runId, actor } };
  }
  const events = (w: World, runId: string) => w.store.listRunEventsPage(runId, { limit: 50 }).events.map((e: { type: string; payload: unknown }) => [e.type, e.payload]);

  test("askQuestion opens a structured question and records the event", async () => {
    const { w, run } = await withRun();
    const result = await tool(w, "agent.askQuestion", { prompt: "Which?", reason: "Need it", options: [{ id: "a" }], allowFreeText: true, maxSelections: 2 }, run);
    const questionId = (outcome(result) as { questionId: string }).questionId;
    expect(outcome(result)).toEqual({ accepted: true, questionId });
    expect(w.store.getQuestion(questionId)).toMatchObject({ prompt: "Which?", reason: "Need it", runId: run.id, allowFreeText: true, maxSelections: 2, minSelections: 1, status: "open" });
    expect(events(w, run.id)).toContainEqual(["question", { questionId }]);
  });

  test("report tools record run events; reportProgress also posts to the conversation", async () => {
    const { w, run } = await withRun();
    for (const [name, event] of [["agent.reportRationale", "report_rationale"], ["agent.reportBlocker", "report_blocker"], ["agent.reportResult", "report_result"], ["agent.reportMilestone", "report_milestone"]] as const) {
      expect(outcome(await tool(w, name, { note: name }, run))).toEqual({ accepted: true });
      expect(events(w, run.id)).toContainEqual([event, { note: name }]);
    }
    await tool(w, "agent.reportProgress", { message: "Halfway" }, run);
    expect(events(w, run.id)).toContainEqual(["report_progress", { message: "Halfway" }]);
    const last = w.store.listConversationMessages("i1").at(-1)!;
    expect(last).toMatchObject({ actorType: "agent", actorId: "kaveh", actorName: "Kaveh", actorTitle: "Implementer", message: "Halfway", runId: run.id, stageId: "implementation" });
  });

  test("recordArtifact records one event for both legacy tool names", async () => {
    const { w, run } = await withRun();
    await tool(w, "agent.recordArtifact", { name: "log", path: "a.txt" }, run);
    expect(events(w, run.id)).toContainEqual(["record_artifact", { name: "log", path: "a.txt" }]);
  });

  test("progress without an actor records only the event", async () => {
    const { w, run } = await withRun();
    const before = w.store.listConversationMessages("i1").length;
    await tool(w, "agent.reportProgress", { message: "x" }, { id: run.id, actor: null });
    expect(w.store.listConversationMessages("i1")).toHaveLength(before);
  });

  test("a tool call needs a run", async () => {
    const { w } = await withRun();
    await expect(tool(w, "agent.reportRationale", {}, undefined)).rejects.toThrow("run");
  });

  test("conversation.get returns the issue's messages, capped at 100", async () => {
    const { w } = await withRun();
    for (let i = 0; i < 3; i++) w.store.appendConversationMessage({ issueId: "i1", runId: null, stageId: "implementation", actorType: "user", actorId: "u", actorName: "U", actorTitle: null, message: `m${i}` });
    const result = outcome(await tool(w, "conversation.get", { limit: 2 }, undefined)) as { issueId: string; messages: Array<{ message: string }> };
    expect(result.issueId).toBe("i1");
    expect(result.messages).toHaveLength(2);
    const all = outcome(await tool(w, "conversation.get", {}, undefined)) as { messages: unknown[] };
    expect(all.messages.length).toBeGreaterThanOrEqual(3);
    expect((await tool(w, "conversation.get", { limit: 1, extra: true }, undefined)).status).toBe("pass");
    expect(registry.require("conversation.get")).toMatchObject({ kind: "tool" });
  });
});
