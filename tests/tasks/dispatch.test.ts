import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { canonicalToolName, AGENT_DENIED_TOOLS } from "../../src/tasks/aliases";
import { defineGroup, fail, pass, TaskInputError, TaskRegistry } from "../../src/tasks/contract";
import { dispatchTool, type DispatchEnv, type ToolGrant } from "../../src/tasks/dispatch";
import { createTaskRegistry } from "../../src/tasks/catalogue";

const runs: string[] = [];

function registry(): TaskRegistry {
  const r = new TaskRegistry();
  r.register(defineGroup("item", [
    {
      name: "item.setThing", kind: "tool", description: "Sets a thing", reads: [], writes: [], invalidates: ["item"], mutating: true,
      input: z.object({ value: z.string().min(1), headSha: z.string().optional() }),
      run({ input, instance }) { runs.push(`${(input as { value: string }).value}@${instance.idempotencyKey}`); return pass({ done: true }); },
    },
    {
      name: "item.getThing", kind: "tool", description: "Gets a thing", reads: [], writes: [], invalidates: [],
      input: z.object({}), run() { return pass({ thing: 1 }); },
    },
    {
      name: "item.broken", kind: "tool", description: "Fails", reads: [], writes: [], invalidates: [], mutating: true,
      input: z.object({}), run() { return fail("nope"); },
    },
  ]));
  r.register(defineGroup("agent", [
    {
      name: "agent.reportProgress", kind: "tool", description: "Reports", reads: [], writes: [], invalidates: [],
      input: z.object({ message: z.string() }), run() { return pass({ accepted: true }); },
    },
  ]));
  return r;
}

function env(head: string | null = "abc"): DispatchEnv & { journal: Map<string, { status: string; response: unknown }> } {
  const journal = new Map<string, { status: string; response: unknown }>();
  let id = 0;
  return {
    registry: registry(),
    deps: () => ({}) as never,
    liveHeadSha: async () => head,
    journal,
    store: {
      beginSourceMutation: ({ idempotencyKey }) => {
        const found = [...journal.entries()].find(([key]) => key === idempotencyKey);
        if (found) return { id: found[0], idempotencyKey, status: found[1].status, response: found[1].response } as never;
        journal.set(idempotencyKey, { status: "pending", response: null });
        id += 1;
        return { id: idempotencyKey, idempotencyKey, status: "pending", response: null, seq: id } as never;
      },
      completeSourceMutation: (key, response) => { journal.set(key, { status: "succeeded", response }); },
      failSourceMutation: (key) => { journal.set(key, { status: "failed", response: null }); },
    },
  };
}

const actor = { id: "kaveh", name: "Kaveh", title: "Implementer" };
const grant = (tasks: string[], over: Partial<ToolGrant> = {}): ToolGrant => ({
  runId: "run-1", stageId: "implementation", issueScoped: true, actor, tasks: new Set(tasks), ...over,
});

describe("alias table", () => {
  test("maps legacy names to canonical camelCase and leaves canonical names alone", () => {
    expect(canonicalToolName("source.get_issue")).toBe("item.get");
    expect(canonicalToolName("workspace.get_context")).toBe("workspace.get");
    expect(canonicalToolName("delivery.get_check_logs")).toBe("ci.getLogs");
    expect(canonicalToolName("workspace.record_artifact")).toBe("agent.recordArtifact");
    expect(canonicalToolName("item.comment")).toBe("item.comment");
  });

  test("every alias target is a registered tool task", () => {
    const tools = new Set(createTaskRegistry().list("tool").map((t) => t.name));
    for (const legacy of ["source.get_issue", "source.get_guidance", "workspace.get_context", "delivery.get_state", "run.ask_question", "run.record_artifact"]) {
      expect(tools.has(canonicalToolName(legacy))).toBe(true);
    }
    expect(createTaskRegistry().require("agent.recordArtifact").mutating).toBe(true);
    expect(AGENT_DENIED_TOOLS).toContain("change.dismissFinding");
  });
});

describe("dispatchTool", () => {
  test("enforces the grant, by canonical or legacy name", async () => {
    const e = env();
    await expect(dispatchTool({ name: "item.getThing", input: {}, grant: grant([]), actor }, e)).rejects.toThrow("MCP tool is not granted: item.getThing");
    expect(await dispatchTool({ name: "item.getThing", input: {}, grant: grant(["item.getThing"]), actor }, e)).toEqual({ thing: 1 });
  });

  test("resolves a legacy alias before checking the grant", async () => {
    const e = env();
    expect(await dispatchTool({ name: "run.report_progress", input: { message: "hi" }, grant: grant(["agent.reportProgress"]), actor }, e)).toEqual({ accepted: true });
  });

  test("rejects an unknown tool", async () => {
    await expect(dispatchTool({ name: "item.nothing", input: {}, grant: grant(["item.nothing"]), actor }, env())).rejects.toThrow("Unknown MCP tool: item.nothing");
  });

  test("invalid input fails with the zod message and runs nothing", async () => {
    const e = env();
    runs.length = 0;
    const call = dispatchTool({ name: "item.setThing", input: { value: "" }, grant: grant(["item.setThing"]), actor }, e);
    await expect(call).rejects.toBeInstanceOf(TaskInputError);
    await expect(call).rejects.toThrow("Invalid input for task item.setThing");
    expect(runs).toEqual([]);
    expect(e.journal.size).toBe(0);
  });

  test("an item tool needs an issue-scoped grant; report tools do not", async () => {
    const e = env();
    const system = grant(["item.getThing", "agent.reportProgress"], { issueScoped: false, actor: null });
    await expect(dispatchTool({ name: "item.getThing", input: {}, grant: system, actor: null }, e)).rejects.toThrow("item.getThing requires an issue-scoped MCP grant");
    expect(await dispatchTool({ name: "agent.reportProgress", input: { message: "x" }, grant: system, actor: null }, e)).toEqual({ accepted: true });
  });

  test("an issue-scoped call needs an actor", async () => {
    await expect(dispatchTool({ name: "item.getThing", input: {}, grant: grant(["item.getThing"], { actor: null }), actor: null }, env())).rejects.toThrow("requires an actor");
  });

  test("a mutating call is journaled by run, tool and input: a retried identical call returns the stored response", async () => {
    const e = env();
    runs.length = 0;
    const g = grant(["item.setThing"]);
    const first = await dispatchTool({ name: "item.setThing", input: { value: "a" }, grant: g, actor }, e);
    const again = await dispatchTool({ name: "item.setThing", input: { value: "a" }, grant: g, actor }, e);
    expect(first).toEqual({ done: true });
    expect(again).toEqual({ done: true });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatch(/^a@mcp:run-1:item\.setThing:[0-9a-f]{64}$/);
    await dispatchTool({ name: "item.setThing", input: { value: "b" }, grant: g, actor }, e);
    expect(runs).toHaveLength(2);
    await dispatchTool({ name: "item.setThing", input: { value: "a" }, grant: { ...g, runId: "run-2" }, actor }, e);
    expect(runs).toHaveLength(3);
  });

  test("a failed mutating call is marked failed and may be retried", async () => {
    const e = env();
    const g = grant(["item.broken"]);
    await expect(dispatchTool({ name: "item.broken", input: {}, grant: g, actor }, e)).rejects.toThrow("nope");
    expect([...e.journal.values()].map((entry) => entry.status)).toEqual(["failed"]);
  });

  test("an input headSha must equal the live change head", async () => {
    const g = grant(["item.setThing"]);
    await expect(dispatchTool({ name: "item.setThing", input: { value: "a", headSha: "old" }, grant: g, actor }, env("new")))
      .rejects.toThrow("headSha old is not the current change head new");
    runs.length = 0;
    await dispatchTool({ name: "item.setThing", input: { value: "a", headSha: "new" }, grant: g, actor }, env("new"));
    expect(runs).toHaveLength(1);
  });

  test("a headSha with no change to compare against fails clearly", async () => {
    await expect(dispatchTool({ name: "item.setThing", input: { value: "a", headSha: "x" }, grant: grant(["item.setThing"]), actor }, env(null)))
      .rejects.toThrow("has no change request");
  });
});
