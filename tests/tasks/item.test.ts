import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { createTaskRegistry } from "../../src/tasks/catalogue";
import type { ItemContext, TaskContext } from "../../src/tasks/context";
import { runTask, type TaskResult } from "../../src/tasks/contract";
import type { TaskDeps } from "../../src/tasks/deps";
import { criteriaFromBody } from "../../src/tasks/item";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const registry = createTaskRegistry();
const run = (name: string, args: Record<string, unknown>) =>
  runTask(registry.require(name), { config: {}, instance: { id: name, stage: "impl", idempotencyKey: "k", resumed: false }, ...args } as never);

const criteriaBody = (...lines: string[]) =>
  `Intro\n\n<!-- conveyor:acceptance-criteria:start -->\n${lines.join("\n")}\n<!-- conveyor:acceptance-criteria:end -->\n`;

function item(overrides: Partial<ItemContext> = {}): ItemContext {
  return {
    id: "i1", number: 1, title: "T", body: "", url: "u", labels: [], state: "open",
    criteria: [], children: [], dependencies: [], systemLabels: [], ...overrides,
  };
}
const ctx = (over: Partial<ItemContext> = {}, repository: Partial<TaskContext["repository"]> = {}) =>
  ({ item: item(over), repository: { id: "repo", address: "o/r", folder: "/f", baseBranch: "main", ciMode: "required", systemLabels: [], ...repository } }) as unknown as Partial<TaskContext>;

describe("item.criteriaDefined", () => {
  test("fails with the exact missing piece when there are no criteria", async () => {
    expect(await run("item.criteriaDefined", { context: ctx() })).toEqual({
      status: "fail",
      message: "Acceptance criteria are missing: add at least one criterion to the managed section",
    });
  });
  test("passes with criteria, and for an item with children", async () => {
    expect((await run("item.criteriaDefined", { context: ctx({ criteria: [{ id: "a", text: "x", manual: false }] }) })).status).toBe("pass");
    expect((await run("item.criteriaDefined", { context: ctx({ children: [{ id: "c", number: 2, state: "open", enrolled: true, hasCriteria: true, hasChildren: false }] }) })).status).toBe("pass");
  });
});

describe("item.labelsValid", () => {
  const repo = { systemLabels: ["area:api", "area:ui"] };
  test("passes when the repository configures no system labels", async () => {
    expect((await run("item.labelsValid", { context: ctx() })).status).toBe("pass");
  });
  test("requires at least one system label when the repository configures them", async () => {
    const result = await run("item.labelsValid", { context: ctx({}, repo) });
    expect(result).toEqual({ status: "fail", message: "System label is missing: add at least one of area:api, area:ui" });
  });
  test("passes when the item has a configured system label", async () => {
    expect((await run("item.labelsValid", { context: ctx({ systemLabels: ["area:ui"] }, repo) })).status).toBe("pass");
  });
});

describe("item.childrenValid", () => {
  test("passes without children", async () => {
    expect((await run("item.childrenValid", { context: ctx() })).status).toBe("pass");
  });
  test("names every child that is not enrolled, not open or done, or has no criteria", async () => {
    const children = [
      { id: "a", number: 2, state: "open", enrolled: true, hasCriteria: true, hasChildren: false },
      { id: "b", number: 3, state: "open", enrolled: false, hasCriteria: true, hasChildren: false },
      { id: "c", number: 4, state: "closed", enrolled: true, hasCriteria: true, hasChildren: false },
      { id: "d", number: 5, state: "done", enrolled: true, hasCriteria: false, hasChildren: false },
    ];
    const result = await run("item.childrenValid", { context: ctx({ children }) });
    expect(result).toEqual({
      status: "fail",
      message: "Children are not ready: #3 is not enrolled; #4 is closed (it must be open or done); #5 has no acceptance criteria",
    });
    expect((await run("item.childrenValid", { context: ctx({ children: children.slice(0, 1) }) })).status).toBe("pass");
    const rollup = { id: "r", number: 6, state: "open", enrolled: true, hasCriteria: false, hasChildren: true };
    expect((await run("item.childrenValid", { context: ctx({ children: [rollup] }) })).status).toBe("pass");
  });
});

describe("item.dependenciesMet", () => {
  test("is pending while a dependency is unsatisfied and lists it", async () => {
    const result = await run("item.dependenciesMet", {
      context: ctx({ dependencies: [{ id: "a", number: 7, satisfied: true }, { id: "b", number: 9, satisfied: false }] }),
    });
    expect(result).toEqual({ status: "pending", message: "Waiting for dependencies: #9" });
  });
  test("passes when all are satisfied or none exist, and waits without a timeout every five minutes", async () => {
    expect((await run("item.dependenciesMet", { context: ctx({ dependencies: [{ id: "a", number: 7, satisfied: true }] }) })).status).toBe("pass");
    expect((await run("item.dependenciesMet", { context: ctx() })).status).toBe("pass");
    expect(registry.require("item.dependenciesMet").defaultWait).toEqual({ timeoutMs: null, pollMs: 300_000 });
  });
});

describe("criteriaFromBody", () => {
  test("extracts criteria text without markers", () => {
    expect(criteriaFromBody(criteriaBody("- [ ] First <!-- conveyor:criterion:a -->", "- [x] [Manual] Second"))).toEqual(["First", "[Manual] Second"]);
    expect(criteriaFromBody("no section")).toEqual([]);
  });
});

async function world() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-item-"));
  directories.push(root);
  const store = await ConveyorStore.open(path.join(root, "db.sqlite"));
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "o/r", folder: "/f", configHash: "h" });
  const add = (id: string, number: number, extra: { body?: string; labels?: string[]; state?: "open" | "closed"; projected?: string } = {}) => {
    store.upsertIssue({
      id, repositoryId: "repo", sourceNumber: number, sourceUrl: `https://x/${number}`, title: `Issue ${number}`,
      body: extra.body ?? "", sourceState: extra.state ?? "open", labels: extra.labels ?? ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    if (extra.projected) store.setIssueProjection(id, { stage: null, state: extra.projected, warning: null });
  };
  const config = {
    labels: { enrollment: "conveyor", stageTemplate: "conveyor:{stage}", states: { done: "conveyor:done" } },
    repositories: { repo: { pipeline: "default", systemLabels: ["area:api", "area:ui"], address: "o/r" } },
    pipelines: { default: { stages: [{ id: "refinement" }, { id: "implementation" }] } },
  } as unknown as ConveyorConfig;
  const calls: Array<[string, unknown]> = [];
  const items = {
    getIssue: async (...a: unknown[]) => { calls.push(["getIssue", a]); return { id: "i", number: 1, body: "B", title: "T", url: "u", state: "open", labels: [], updatedAt: "" }; },
    addComment: async (...a: unknown[]) => { calls.push(["addComment", a]); return 42; },
    updateManagedSection: async (input: unknown) => { calls.push(["updateManagedSection", input]); return { body: "updated" }; },
    managedRevision: (body: string) => `rev:${body}`,
    setParent: async (i: unknown) => { calls.push(["setParent", i]); },
    setDependencies: async (i: unknown) => { calls.push(["setDependencies", i]); },
    replaceManagedProjectLabels: async (...a: unknown[]) => { calls.push(["replaceManagedProjectLabels", a]); },
    createChildIssue: async (i: unknown) => { calls.push(["createChildIssue", i]); return { id: "c", number: 99 }; },
  } as unknown as TaskDeps["items"];
  const deps = (issueId = "i1"): TaskDeps => ({
    store, config, items, repository: { id: "repo", address: "o/r", folder: "/f", baseBranch: "main" }, issueId, sourceGuidance: "GUIDE",
    git: {} as TaskDeps["git"], workspaces: {} as TaskDeps["workspaces"],
  });
  return { store, add, deps, calls };
}

describe("item.load", () => {
  test("loads the stored issue with criteria, children, dependencies and system labels", async () => {
    const w = await world();
    w.add("i1", 1, {
      body: criteriaBody("- [ ] Do it <!-- conveyor:criterion:c1 -->", "- [ ] [Manual] Look at it <!-- conveyor:criterion:c2 -->", "- [x] Bare"),
      labels: ["area:api", "conveyor", "other"],
    });
    w.add("kid", 2, { body: criteriaBody("- [ ] k"), projected: "active" });
    w.add("kid2", 3, { labels: [], state: "closed" });
    w.add("dep-open", 4);
    w.add("dep-closed", 5, { state: "closed" });
    w.add("dep-done", 6, { projected: "done" });
    w.store.replaceRelationships("kid", { parentId: "i1", siblingOrder: 1 }, []);
    w.store.replaceRelationships("kid2", { parentId: "i1", siblingOrder: 2 }, []);
    w.store.replaceRelationships("i1", null, ["dep-open", "dep-closed", "dep-done"]);
    const result = await run("item.load", { context: {}, deps: w.deps() }) as Extract<TaskResult, { status: "pass" }>;
    expect(result.status).toBe("pass");
    expect(result.output).toEqual({
      id: "i1", number: 1, title: "Issue 1", url: "https://x/1", state: "open",
      body: criteriaBody("- [ ] Do it <!-- conveyor:criterion:c1 -->", "- [ ] [Manual] Look at it <!-- conveyor:criterion:c2 -->", "- [x] Bare"),
      labels: ["area:api", "conveyor", "other"],
      criteria: [
        { id: "c1", text: "Do it", manual: false },
        { id: "c2", text: "[Manual] Look at it", manual: true },
        { id: "criterion-3", text: "Bare", manual: false },
      ],
      children: [
        { id: "kid", number: 2, state: "open", enrolled: true, hasCriteria: true, hasChildren: false },
        { id: "kid2", number: 3, state: "closed", enrolled: false, hasCriteria: false, hasChildren: false },
      ],
      dependencies: [
        { id: "dep-closed", number: 5, satisfied: true },
        { id: "dep-done", number: 6, satisfied: true },
        { id: "dep-open", number: 4, satisfied: false },
      ],
      systemLabels: ["area:api"],
    });
  });
});

describe("item tools", () => {
  const tool = (name: string, deps: TaskDeps, input: unknown, stage = "refinement") =>
    run(name, { context: {}, deps, input, actor: "agent", instance: { id: name, stage, idempotencyKey: "k", resumed: false } }) as Promise<Extract<TaskResult, { status: "pass" }>>;

  test("are declared as mutating or not, invalidating item", () => {
    for (const name of ["item.setCriteria", "item.setSystemLabels", "item.setParent", "item.setDependencies", "item.createChild", "item.comment"]) {
      expect(registry.require(name)).toMatchObject({ kind: "tool", mutating: true, invalidates: ["item"] });
    }
    for (const name of ["item.get", "item.guidance"]) {
      expect(registry.require(name)).toMatchObject({ kind: "tool", invalidates: [] });
      expect(registry.require(name).mutating).toBeFalsy();
    }
  });

  test("get and guidance read", async () => {
    const w = await world(); w.add("i1", 5);
    expect((await tool("item.get", w.deps(), {})).output).toMatchObject({ body: "B" });
    expect(w.calls[0]).toEqual(["getIssue", ["o/r", 5]]);
    expect((await tool("item.guidance", w.deps(), {})).output).toBe("GUIDE");
  });

  test("comment returns the comment id", async () => {
    const w = await world(); w.add("i1", 5);
    expect((await tool("item.comment", w.deps(), { markdown: "hi" })).output).toEqual({ commentId: 42 });
    expect(w.calls).toEqual([["addComment", ["o/r", 5, "hi"]]]);
  });

  test("setCriteria writes the managed section against the current revision", async () => {
    const w = await world(); w.add("i1", 5);
    const out = await tool("item.setCriteria", w.deps(), { criteria: [{ id: "a", text: "First" }] });
    expect(out.output).toEqual({ revision: "rev:updated" });
    expect(w.calls[1]).toEqual(["updateManagedSection", {
      address: "o/r", issueNumber: 5, section: "acceptance-criteria",
      markdown: "- [ ] First <!-- conveyor:criterion:a -->", expectedRevision: "rev:B",
    }]);
  });

  test("setSystemLabels keeps only configured labels", async () => {
    const w = await world(); w.add("i1", 5);
    await tool("item.setSystemLabels", w.deps(), { labels: ["area:ui", "bogus"] });
    expect(w.calls).toEqual([["replaceManagedProjectLabels", ["o/r", 5, ["area:api", "area:ui"], ["area:ui"]]]]);
  });

  test("setParent and setDependencies", async () => {
    const w = await world(); w.add("i1", 5);
    expect((await tool("item.setParent", w.deps(), { parentNumber: 3 })).output).toEqual({ accepted: true });
    await tool("item.setDependencies", w.deps(), { issueNumbers: [7, 8] });
    expect(w.calls.map((c) => c[0])).toEqual(["setParent", "setDependencies", "getIssue", "updateManagedSection"]);
    expect(w.calls[1]![1]).toEqual({ address: "o/r", issueNumber: 5, blockerNumbers: [7, 8] });
    expect(w.calls[3]![1]).toMatchObject({ section: "dependencies", markdown: "- #7\n- #8" });
  });

  test("createChild labels the child for the next stage and keeps configured system labels only", async () => {
    const w = await world(); w.add("i1", 5);
    const out = await tool("item.createChild", w.deps(), {
      title: "Kid", body: "Body", acceptanceCriteria: [{ id: "a", text: "Do" }], systemLabels: ["area:api", "bogus"],
    });
    expect(out.output).toEqual({ id: "c", number: 99 });
    expect(w.calls[0]![1]).toMatchObject({
      address: "o/r", parentNumber: 5, title: "Kid",
      labels: ["conveyor", "conveyor:implementation", "area:api"],
    });
    expect((w.calls[0]![1] as { body: string }).body).toContain("- [ ] Do <!-- conveyor:criterion:a -->");
  });

  test("tool input is validated", async () => {
    const w = await world(); w.add("i1", 5);
    await expect(tool("item.createChild", w.deps(), { title: "Kid", body: "b", acceptanceCriteria: [] })).rejects.toThrow();
    await expect(tool("item.setParent", w.deps(), { parentNumber: -1 })).rejects.toThrow();
  });
});
