import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { createTaskRegistry } from "../../src/tasks/catalogue";
import type { ItemContext, TaskContext } from "../../src/tasks/context";
import { runTask, type TaskResult } from "../../src/tasks/contract";
import type { TaskDeps } from "../../src/tasks/deps";
import { ToolRequestError } from "../../src/tasks/errors";
import { parseBreakdownPlan, renderBreakdownPlan, type BreakdownPlan } from "../../src/tasks/breakdown";
import { criteriaFromBody } from "../../src/tasks/item";
import { parseManagedSections, renderAcceptanceCriteriaSection, upsertManagedSection, type ManagedSectionName } from "../../src/source/github/managed-sections";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const registry = createTaskRegistry();
const run = (name: string, args: Record<string, unknown>) =>
  runTask(registry.require(name), { config: {}, instance: { id: name, stage: "impl", idempotencyKey: "k", resumed: false }, ...args } as never);
const runAt = (name: string, stage: string, args: Record<string, unknown>) =>
  runTask(registry.require(name), { config: {}, instance: { id: name, stage, idempotencyKey: "k", resumed: false }, ...args } as never);

const criteriaBody = (...lines: string[]) =>
  `Intro\n\n<!-- conveyor:acceptance-criteria:start -->\n${lines.join("\n")}\n<!-- conveyor:acceptance-criteria:end -->\n`;

function item(overrides: Partial<ItemContext> = {}): ItemContext {
  return {
    id: "i1", number: 1, title: "T", url: "u", labels: [], state: "open",
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

describe("item.refinementComplete", () => {
  const required = { fields: ["Effort", "Priority"], require: { type: true, fields: ["Effort"], section: true } };
  const full = { type: "Task", typesAvailable: true, fields: { Effort: "Low" }, definedFields: ["Effort"], section: true };
  const gate = (refinement: Partial<NonNullable<ItemContext["refinement"]>> | undefined, repository: Record<string, unknown> = { refinement: required }) =>
    run("item.refinementComplete", { context: ctx(refinement ? { refinement: { ...full, ...refinement } } : {}, repository) });

  test("passes when nothing is required, or everything required is filled", async () => {
    expect((await gate(undefined, {})).status).toBe("pass");
    expect((await gate({})).status).toBe("pass");
  });
  test("names every missing output", async () => {
    expect(await gate({ type: null, fields: {}, section: false })).toEqual({
      status: "fail",
      message: "Refinement outputs are missing: issue type (set it with item.setType); issue field Effort (set it with item.setFields); Refinement section (write it with item.setRefinement)",
    });
    expect(await gate({ section: false })).toEqual({ status: "fail", message: "Refinement outputs are missing: Refinement section (write it with item.setRefinement)" });
    expect((await gate({ fields: { effort: "  " } })).status).toBe("fail");
  });
  test("does not require a type or field the organization does not offer", async () => {
    expect((await gate({ type: null, typesAvailable: false, fields: {}, definedFields: [] })).status).toBe("pass");
    expect((await gate({ type: null, typesAvailable: false, fields: {}, definedFields: [], section: false })).status).toBe("fail");
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

  test("falls back to task-list items under an acceptance criteria heading", () => {
    expect(criteriaFromBody([
      "Issue context.",
      "",
      "## Acceptance criteria",
      "- [ ] Works offline",
      "- [x] Preserves **existing** data",
      "",
      "## Implementation notes",
      "- [ ] This is not a criterion",
    ].join("\n"))).toEqual(["Works offline", "Preserves **existing** data"]);
  });
});

type RefinementConfig = { fields: string[]; require: { type: boolean; fields: string[]; section: boolean } };
const REFINEMENT: RefinementConfig = { fields: ["Effort", "Priority"], require: { type: true, fields: ["Effort"], section: true } };
const EFFORT = { id: 11, name: "Effort", dataType: "single_select", options: ["High", "Medium", "Low"] };
const TARGET = { id: 12, name: "Target date", dataType: "date", options: [] };
const PRIORITY = { id: 13, name: "Priority", dataType: "single_select", options: ["Urgent", "High", "Medium", "Low"] };

async function world(options: {
  refinement?: RefinementConfig;
  types?: string[] | null;
  fields?: unknown[] | null;
  systemLabels?: string[];
  values?: Record<string, string>;
  children?: number[];
  failTitleWriteOnce?: boolean;
  failDependencyWriteOnce?: boolean;
  failDependencySectionWriteOnce?: boolean;
  breakdownFailAfterCreates?: number;
  pipelineStages?: string[];
  childrenStartAt?: string;
  noSplitLabel?: string;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-item-"));
  directories.push(root);
  const store = await ConveyorStore.open(path.join(root, "db.sqlite"));
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "o/r", folder: "/f", configHash: "h" });
  const sources = new Map<number, { id: string; number: number; url: string; title: string; body: string; state: "open" | "closed"; labels: string[]; updatedAt: string; type?: string | null }>();
  const source = (number: number) => sources.get(number) ?? {
    id: `github:o/r#${number}`, number, url: `https://x/${number}`, title: `Issue ${number}`, body: "",
    state: "open" as const, labels: [], updatedAt: "2026-01-01T00:00:00Z",
  };
  const add = (id: string, number: number, extra: { body?: string; labels?: string[]; state?: "open" | "closed"; projected?: string } = {}) => {
    store.upsertIssue({
      id, repositoryId: "repo", sourceNumber: number, sourceUrl: `https://x/${number}`, title: `Issue ${number}`,
      body: extra.body ?? "", sourceState: extra.state ?? "open", labels: extra.labels ?? ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    sources.set(number, {
      id, number, url: `https://x/${number}`, title: `Issue ${number}`, body: extra.body ?? "",
      state: extra.state ?? "open", labels: extra.labels ?? ["conveyor"], updatedAt: "2026-01-01T00:00:00Z",
    });
    if (extra.projected) store.setIssueProjection(id, { stage: null, state: extra.projected, warning: null });
  };
  const updateLiveSource = (number: number, extra: Partial<ReturnType<typeof source>>) => {
    sources.set(number, { ...source(number), ...extra });
  };
  const config = {
    labels: {
      enrollment: "conveyor", stageTemplate: "conveyor:{stage}", states: { done: "conveyor:done" },
      metadata: { closable: "conveyor:closable", noSplit: options.noSplitLabel ?? "conveyor:no-split", orderTemplate: "conveyor:order:{number}" },
    },
    repositories: { repo: { pipeline: "default", systemLabels: options.systemLabels ?? ["area:api", "area:ui"], address: "o/r", ...(options.refinement ? { refinement: options.refinement } : {}) } },
    pipelines: { default: { stages: (options.pipelineStages ?? ["refinement", "implementation"]).map((id) => ({
      id,
      ...(id === "work-breakdown" && options.childrenStartAt ? { childrenStartAt: options.childrenStartAt } : {}),
    })) } },
  } as unknown as ConveyorConfig;
  const calls: Array<[string, unknown]> = [];
  let nextBreakdownChild = 100;
  let breakdownFailureRaised = false;
  const items = {
    getIssue: async (...a: unknown[]) => { calls.push(["getIssue", a]); return source(a[1] as number); },
    addComment: async (...a: unknown[]) => { calls.push(["addComment", a]); return 42; },
    updateManagedSection: async (input: unknown) => {
      calls.push(["updateManagedSection", input]);
      if (options.failDependencySectionWriteOnce) {
        options.failDependencySectionWriteOnce = false;
        throw new Error("temporary dependency section failure");
      }
      const write = input as { issueNumber: number; section: ManagedSectionName; markdown: string; expectedRevision: string };
      const current = source(write.issueNumber);
      const updated = { ...current, body: upsertManagedSection(current.body, write.section, write.markdown, write.expectedRevision) };
      sources.set(updated.number, updated);
      return updated;
    },
    managedRevision: (body: string) => parseManagedSections(body).revision,
    setParent: async (i: unknown) => { calls.push(["setParent", i]); },
    setDependencies: async (i: unknown) => {
      calls.push(["setDependencies", i]);
      if (options.failDependencyWriteOnce) {
        options.failDependencyWriteOnce = false;
        throw new Error("temporary dependency failure");
      }
    },
    replaceManagedProjectLabels: async (...a: unknown[]) => {
      calls.push(["replaceManagedProjectLabels", a]);
      const [_, number, managed, selected] = a as [string, number, string[], string[]];
      const current = source(number);
      sources.set(number, { ...current, labels: [...new Set([...current.labels.filter((label) => !managed.includes(label)), ...selected])].sort() });
    },
    replaceConveyorLabels: async (...a: unknown[]) => {
      calls.push(["replaceConveyorLabels", a]);
      const [_, number, labels] = a as [string, number, string[]];
      const current = source(number);
      sources.set(number, { ...current, labels: [...new Set([...current.labels.filter((label) => !label.startsWith("conveyor")), ...labels])].sort() });
    },
    createChildIssue: async (i: unknown) => {
      calls.push(["createChildIssue", i]);
      const input = i as { title: string; body: string; labels: string[]; type?: string };
      if (options.breakdownFailAfterCreates !== undefined) {
        const marker = /<!-- conveyor:child-create:([a-f0-9]{64}) -->/.exec(input.body)?.[0];
        const existing = marker ? [...sources.values()].find((candidate) => candidate.body.includes(marker)) : undefined;
        if (existing) return existing;
        if (!breakdownFailureRaised && nextBreakdownChild - 100 >= options.breakdownFailAfterCreates) {
          breakdownFailureRaised = true;
          throw new Error("interrupted child creation");
        }
        const number = nextBreakdownChild++;
        const child = { id: `child-${number}`, number, url: `https://x/${number}`, title: input.title, body: input.body, state: "open" as const, labels: input.labels, updatedAt: "2026-01-01T00:00:00Z", ...(input.type !== undefined ? { type: input.type } : {}) };
        sources.set(child.number, child);
        return child;
      }
      const child = { id: "c", number: 99, url: "https://x/99", title: input.title, body: input.body, state: "open" as const, labels: input.labels, updatedAt: "2026-01-01T00:00:00Z", ...(input.type !== undefined ? { type: input.type } : {}) };
      sources.set(child.number, child);
      return child;
    },
    listSubIssues: async (_address: string, _parentNumber: number) => (options.children ?? []).map((number) => ({ id: `child-${number}`, number })),
    setTitle: async (...a: unknown[]) => {
      calls.push(["setTitle", a]);
      if (options.failTitleWriteOnce) {
        options.failTitleWriteOnce = false;
        throw new Error("temporary title failure");
      }
      const [_, number, title] = a as [string, number, string];
      sources.set(number, { ...source(number), title });
    },
    listIssueTypes: async () => (options.types === undefined ? ["Task", "Bug", "Feature"] : options.types),
    listIssueFields: async () => (options.fields === undefined ? [EFFORT, TARGET, PRIORITY] : options.fields),
    getIssueFieldValues: async () => (options.values ?? {}),
    setIssueType: async (...a: unknown[]) => { calls.push(["setIssueType", a]); },
    setIssueFieldValues: async (...a: unknown[]) => { calls.push(["setIssueFieldValues", a]); },
  } as unknown as TaskDeps["items"];
  const deps = (issueId = "i1"): TaskDeps => ({
    store, config, items, repository: { id: "repo", address: "o/r", folder: "/f", baseBranch: "main" }, issueId, sourceGuidance: "GUIDE",
    git: {} as TaskDeps["git"], workspaces: {} as TaskDeps["workspaces"],
  });
  return { store, add, updateLiveSource, source, deps, calls };
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
      labels: ["area:api", "conveyor", "other"],
      criteria: [
        { id: "c1", text: "Do it", manual: false },
        { id: "c2", text: "[Manual] Look at it", manual: true },
        { id: "criterion-3", text: "Bare", manual: false },
      ],
      children: [
        { id: "kid", number: 2, state: "open", enrolled: true, hasCriteria: true, hasChildren: false, title: "Issue 2", body: criteriaBody("- [ ] k"), labels: ["conveyor"], dependsOn: [] },
        { id: "kid2", number: 3, state: "closed", enrolled: false, hasCriteria: false, hasChildren: false, title: "Issue 3", body: "", labels: [], dependsOn: [] },
      ],
      dependencies: [
        { id: "dep-closed", number: 5, satisfied: true },
        { id: "dep-done", number: 6, satisfied: true },
        { id: "dep-open", number: 4, satisfied: false },
      ],
      systemLabels: ["area:api"],
      refinement: { type: null, typesAvailable: false, fields: {}, definedFields: [], section: false },
    });
  });

  test("tells agents when a labelled item must remain whole", async () => {
    const w = await world({ noSplitLabel: "workflow:keep-whole" });
    w.add("i1", 1, { labels: ["conveyor", "workflow:keep-whole"] });

    const labelled = (await run("item.load", { context: {}, deps: w.deps() }) as Extract<TaskResult, { status: "pass" }>).output as ItemContext;
    expect(labelled.noSplit).toEqual({
      label: "workflow:keep-whole",
      instruction: expect.stringMatching(/must remain one item.*whole scope.*needs-input.*do not create children/i),
    });

    w.add("plain", 2, { labels: ["conveyor"] });
    const plain = (await run("item.load", { context: {}, deps: w.deps("plain") }) as Extract<TaskResult, { status: "pass" }>).output as ItemContext;
    expect(plain).not.toHaveProperty("noSplit");
  });
});

describe("item.load refinement outputs", () => {
  test("reads the stored type, live field values and the Refinement section, limited to what the organization offers", async () => {
    const w = await world({ refinement: REFINEMENT, types: ["Bug"], fields: [EFFORT, PRIORITY] });
    w.add("i1", 1, { body: "Intro\n\n<!-- conveyor:refinement:start -->\n## Refinement\n\nSummary\n<!-- conveyor:refinement:end -->\n" });
    w.store.setIssueMetadata("i1", { type: "Bug" });
    const result = await run("item.load", { context: {}, deps: w.deps() }) as Extract<TaskResult, { status: "pass" }>;
    expect((result.output as ItemContext).refinement).toEqual({ type: "Bug", typesAvailable: true, fields: {}, definedFields: ["Effort"], section: true });
    const bare = await world({ refinement: REFINEMENT, types: null, fields: null });
    bare.add("i1", 1);
    const none = await run("item.load", { context: {}, deps: bare.deps() }) as Extract<TaskResult, { status: "pass" }>;
    expect((none.output as ItemContext).refinement).toEqual({ type: null, typesAvailable: false, fields: {}, definedFields: [], section: false });
  });

  test("replaces stale stored fields with the live gate snapshot", async () => {
    const w = await world({ refinement: REFINEMENT, types: ["Bug"], fields: [EFFORT], values: {} });
    w.add("i1", 1);
    w.store.setIssueMetadata("i1", { fields: { Effort: "High" } });
    const result = await run("item.load", { context: {}, deps: w.deps() }) as Extract<TaskResult, { status: "pass" }>;
    expect((result.output as ItemContext).refinement?.fields).toEqual({});
  });
});

describe("item tools", () => {
  const tool = (name: string, deps: TaskDeps, input: unknown, stage = "refinement") =>
    run(name, { context: {}, deps, input, actor: "agent", instance: { id: name, stage, idempotencyKey: "k", resumed: false } }) as Promise<Extract<TaskResult, { status: "pass" }>>;

  test("are declared as mutating or not, invalidating item", () => {
    for (const name of ["item.setCriteria", "item.setType", "item.setFields", "item.setRefinement", "item.setTitle", "item.setSystemLabels", "item.setParent", "item.setDependencies", "item.createChild", "item.comment"]) {
      expect(registry.require(name)).toMatchObject({ kind: "tool", mutating: true, invalidates: ["item"] });
    }
    for (const name of ["item.get", "item.guidance", "item.listOpen"]) {
      expect(registry.require(name)).toMatchObject({ kind: "tool", invalidates: [] });
      expect(registry.require(name).mutating).toBeFalsy();
    }
  });

  test("get and guidance read the accepted stored snapshot", async () => {
    const w = await world({ noSplitLabel: "workflow:keep-whole" }); w.add("i1", 5, { body: "B", labels: ["conveyor", "workflow:keep-whole"] });
    w.updateLiveSource(5, { body: "Untrusted live body" });
    expect((await tool("item.get", w.deps(), {})).output).toMatchObject({
      body: "B",
      noSplit: { label: "workflow:keep-whole", instruction: expect.stringMatching(/must remain one item/i) },
    });
    expect(w.calls).not.toContainEqual(["getIssue", ["o/r", 5]]);
    w.add("plain", 6, { labels: ["conveyor"] });
    expect((await tool("item.get", w.deps("plain"), {})).output).not.toHaveProperty("noSplit");
    expect((await tool("item.guidance", w.deps(), {})).output).toBe("GUIDE");
  });

  test("listOpen lists the repository's other open items with their branch, so overlapping work can be found", async () => {
    const w = await world();
    w.add("i1", 5);
    w.add("i2", 6, { body: "Edits the duel registry.", projected: "active" });
    w.add("i3", 7, { projected: "done" });
    w.add("i4", 8, { state: "closed" });
    w.add("i5", 9, { labels: [] });
    w.add("parent", 4, { projected: "active" });
    w.store.replaceRelationships("i2", { parentId: "parent", siblingOrder: 1 }, ["i1"]);
    const enrollment = w.store.activateEnrollment("i2");
    w.store.recordWorkspace({ id: "ws", enrollmentId: enrollment.id, path: "/w", branch: "conveyor/6-duels", status: "active" });
    const listed = (await tool("item.listOpen", w.deps(), {})).output as { items: Array<Record<string, unknown>> };
    expect(listed.items.map((item) => item.number)).toEqual([4, 6]);
    expect(listed.items[1]).toEqual({
      number: 6, title: "Issue 6", stage: null, state: "active", parentNumber: 4, dependsOn: [5],
      branch: "conveyor/6-duels", body: "Edits the duel registry.",
    });
    w.add("long", 10, { body: "x".repeat(5000) });
    const long = ((await tool("item.listOpen", w.deps(), {})).output as { items: Array<{ number: number; body: string }> }).items.find((item) => item.number === 10)!;
    expect(long.body.length).toBeLessThanOrEqual(2001);
  });

  test("comment returns the comment id", async () => {
    const w = await world(); w.add("i1", 5);
    expect((await tool("item.comment", w.deps(), { markdown: "hi" })).output).toEqual({ commentId: 42 });
    expect(w.calls).toEqual([["addComment", ["o/r", 5, "hi"]]]);
  });

  test("setCriteria writes the managed section against the current revision", async () => {
    const w = await world(); w.add("i1", 5, { body: "B" });
    const out = await tool("item.setCriteria", w.deps(), { criteria: [{ id: "a", text: "First" }] });
    expect(out.output).toMatchObject({ revision: expect.any(String) });
    expect(w.calls[1]).toEqual(["updateManagedSection", {
      address: "o/r", issueNumber: 5, section: "acceptance-criteria",
      markdown: "## Acceptance Criteria\n\n- [ ] First <!-- conveyor:criterion:a -->", expectedRevision: expect.any(String),
    }]);
  });

  test("setTitle replaces the current issue's title, trimmed", async () => {
    const w = await world(); w.add("i1", 5);
    expect((await tool("item.setTitle", w.deps(), { title: "  Players pick categories per family  " })).output).toEqual({ title: "Players pick categories per family" });
    expect(w.calls).toEqual([
      ["setTitle", ["o/r", 5, "Players pick categories per family"]],
      ["getIssue", ["o/r", 5]],
    ]);
  });

  test("setSystemLabels rejects unconfigured labels before changing labels", async () => {
    const w = await world(); w.add("i1", 5);
    await expect(tool("item.setSystemLabels", w.deps(), { labels: ["area:ui", "bogus"] })).rejects
      .toThrow("Allowed system labels: area:api, area:ui");
    expect(w.calls).toEqual([]);
  });

  test("setSystemLabels names an empty configured list and changes no labels", async () => {
    const w = await world({ systemLabels: [] }); w.add("i1", 5);
    await expect(tool("item.setSystemLabels", w.deps(), { labels: ["area:ui"] })).rejects
      .toThrow("Allowed system labels: none");
    expect(w.calls).toEqual([]);
  });

  test("keeps a successful system-label replacement visible to item.load and its gate", async () => {
    const w = await world();
    w.add("i1", 5, { labels: ["area:api", "conveyor", "conveyor:refinement", "customer-label"] });

    await tool("item.setSystemLabels", w.deps(), { labels: ["area:ui"] });

    expect(w.store.getIssue("i1")!.labels).toEqual(["area:ui", "conveyor", "conveyor:refinement", "customer-label"]);
    const loaded = (await run("item.load", { context: {}, deps: w.deps() }) as Extract<TaskResult, { status: "pass" }>).output as ItemContext;
    expect(loaded.systemLabels).toEqual(["area:ui"]);
    expect((await run("item.labelsValid", { context: ctx(loaded, { systemLabels: ["area:api", "area:ui"] }) })).status).toBe("pass");
  });

  test("setParent and setDependencies", async () => {
    const w = await world(); w.add("i1", 5);
    expect((await tool("item.setParent", w.deps(), { parentNumber: 3 })).output).toEqual({ accepted: true });
    await tool("item.setDependencies", w.deps(), { issueNumbers: [7, 8] });
    expect(w.calls.map((c) => c[0])).toEqual(["setParent", "getIssue", "setDependencies", "getIssue", "updateManagedSection", "getIssue", "getIssue"]);
    expect(w.calls[2]![1]).toEqual({ address: "o/r", issueNumber: 5, blockerNumbers: [7, 8] });
    expect(w.calls[4]![1]).toMatchObject({ section: "dependencies", markdown: "- #7\n- #8" });
    expect(w.store.listChildren("github:o/r#3").map((child) => child.issueId)).toEqual(["i1"]);
    expect(w.store.listDependencies("i1")).toEqual(["github:o/r#7", "github:o/r#8"]);
  });

  test("keeps successful content writes visible to the next refinement gates", async () => {
    const refinement = { fields: [], require: { type: false, fields: [], section: true } };
    const w = await world({ refinement });
    w.add("i1", 5, { body: "Unmanaged introduction." });
    w.add("dep", 7, { state: "closed" });

    await tool("item.setTitle", w.deps(), { title: "Updated title" });
    await tool("item.setCriteria", w.deps(), { criteria: [{ id: "criterion", text: "Visible now" }] });
    await tool("item.setRefinement", w.deps(), { summary: "Ready for the gate." });
    await tool("item.setDependencies", w.deps(), { issueNumbers: [7] });

    const stored = w.store.getIssue("i1")!;
    expect(stored.title).toBe("Updated title");
    expect(stored.body).toContain("Unmanaged introduction.");
    expect(parseManagedSections(stored.body).sections).toMatchObject({
      "acceptance-criteria": expect.stringContaining("Visible now"),
      refinement: expect.stringContaining("Ready for the gate."),
      dependencies: "- #7",
    });
    const loaded = (await run("item.load", { context: {}, deps: w.deps() }) as Extract<TaskResult, { status: "pass" }>).output as ItemContext;
    expect(loaded).toMatchObject({ title: "Updated title", criteria: [{ id: "criterion", text: "Visible now" }], dependencies: [{ id: "dep", number: 7, satisfied: true }] });
    expect((await run("item.criteriaDefined", { context: ctx(loaded) })).status).toBe("pass");
    expect((await run("item.refinementComplete", { context: ctx(loaded, { refinement }) })).status).toBe("pass");
    expect(loaded.refinement?.section).toBe(true);
  });

  test("does not project failed writes or rejected managed sections into the store", async () => {
    const failedTitle = await world({ failTitleWriteOnce: true });
    failedTitle.add("i1", 5);
    await expect(tool("item.setTitle", failedTitle.deps(), { title: "Not stored" })).rejects.toThrow("temporary title failure");
    expect(failedTitle.store.getIssue("i1")!.title).toBe("Issue 5");

    const rejectedSection = await world({ failDependencySectionWriteOnce: true });
    rejectedSection.add("i1", 5, { body: "Original body." });
    rejectedSection.add("existing", 2);
    rejectedSection.store.replaceRelationships("i1", null, ["existing"]);
    await expect(tool("item.setDependencies", rejectedSection.deps(), { issueNumbers: [7] })).rejects.toThrow("temporary dependency section failure");
    expect(rejectedSection.store.getIssue("i1")!.body).toBe("Original body.");
    expect(rejectedSection.store.listDependencies("i1")).toEqual(["existing"]);
  });

  test("createChild labels the child for the next stage and keeps configured system labels only", async () => {
    const w = await world(); w.add("i1", 5);
    const out = await tool("item.createChild", w.deps(), {
      title: "Kid", body: "Body", acceptanceCriteria: [{ id: "a", text: "Do" }], systemLabels: ["area:api", "bogus"],
    });
    expect(out.output).toMatchObject({ id: "c", number: 99 });
    expect(w.calls[1]![1]).toMatchObject({
      address: "o/r", parentNumber: 5, title: "Kid",
      labels: ["conveyor", "conveyor:implementation", "area:api"],
    });
    expect((w.calls[1]![1] as { labels: string[] }).labels).not.toContain("conveyor:no-split");
    expect((w.calls[1]![1] as { body: string }).body).toContain("- [ ] Do <!-- conveyor:criterion:a -->");
  });

  test("createChild refuses a no-split parent before any mutation and keeps existing children", async () => {
    const w = await world({ noSplitLabel: "workflow:keep-whole" });
    w.add("i1", 5, { labels: ["conveyor", "workflow:keep-whole"] });
    w.add("existing", 7);
    w.store.replaceRelationships("existing", { parentId: "i1", siblingOrder: 1 }, []);

    await expect(tool("item.createChild", w.deps(), {
      title: "Kid", body: "Body", acceptanceCriteria: [{ id: "a", text: "Do" }],
    })).rejects.toThrow(/workflow:keep-whole.*whole item.*needs-input/i);
    expect(w.calls).toEqual([["getIssue", ["o/r", 5]]]);
    expect(w.store.listChildren("i1")).toEqual([{ issueId: "existing", siblingOrder: 1 }]);
  });

  test("createChild refuses when the no-split label was added after the item was loaded", async () => {
    const w = await world({ noSplitLabel: "workflow:keep-whole" });
    w.add("i1", 5);
    w.updateLiveSource(5, { labels: ["conveyor", "workflow:keep-whole"] });

    await expect(tool("item.createChild", w.deps(), {
      title: "Kid", body: "Body", acceptanceCriteria: [{ id: "a", text: "Do" }],
    })).rejects.toThrow(/workflow:keep-whole.*whole item.*needs-input/i);
    expect(w.calls).toEqual([["getIssue", ["o/r", 5]]]);
    expect(w.store.listChildren("i1")).toEqual([]);
  });

  test("createChild records sibling and cross-parent dependencies and waits for all of them", async () => {
    const w = await world(); w.add("i1", 5); w.add("sibling", 7, { body: criteriaBody("- [ ] Existing <!-- conveyor:criterion:existing -->") }); w.add("cross-parent", 8);
    w.store.replaceRelationships("sibling", { parentId: "i1", siblingOrder: null }, []);
    const out = await tool("item.createChild", w.deps(), {
      title: "Later child", body: "Body", acceptanceCriteria: [{ id: "a", text: "Do" }], dependsOn: [7, 8],
    });

    expect(out.output).toMatchObject({ id: "c", number: 99, dependsOn: [7, 8] });
    expect(w.calls.map(([name]) => name)).toEqual(["getIssue", "getIssue", "getIssue", "createChildIssue", "setDependencies", "getIssue", "updateManagedSection", "replaceConveyorLabels", "getIssue", "getIssue", "getIssue"]);
    expect(w.calls[3]![1]).toMatchObject({ labels: [] });
    expect(w.calls[4]![1]).toEqual({ address: "o/r", issueNumber: 99, blockerNumbers: [7, 8] });
    expect(w.calls[6]![1]).toMatchObject({ issueNumber: 99, section: "dependencies", markdown: "- #7\n- #8" });
    expect(w.calls[7]![1]).toEqual(["o/r", 99, ["conveyor", "conveyor:implementation"], ["conveyor:no-split"]]);

    expect(w.store.getIssue("c")).toMatchObject({
      labels: ["conveyor", "conveyor:implementation"],
      body: expect.stringContaining("Do <!-- conveyor:criterion:a -->"),
    });
    expect(w.store.listChildren("i1").map((child) => child.issueId)).toEqual(expect.arrayContaining(["c", "sibling"]));
    expect(w.store.listDependencies("c")).toEqual(["cross-parent", "sibling"]);

    const parent = (await run("item.load", { context: {}, deps: w.deps() }) as Extract<TaskResult, { status: "pass" }>).output as ItemContext;
    expect(parent.children).toEqual(expect.arrayContaining([expect.objectContaining({ id: "c", number: 99, enrolled: true, hasCriteria: true })]));
    expect((await run("item.childrenValid", { context: ctx(parent) })).status).toBe("pass");

    const child = (await run("item.load", { context: {}, deps: w.deps("c") }) as Extract<TaskResult, { status: "pass" }>).output as ItemContext;
    expect(child).toMatchObject({ criteria: [{ id: "a", text: "Do" }] });
    expect(child.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ number: 7, satisfied: false }),
      expect.objectContaining({ number: 8, satisfied: false }),
    ]));
    expect(await run("item.dependenciesMet", { context: ctx(child) })).toEqual({ status: "pending", message: "Waiting for dependencies: #8, #7" });
    w.add("sibling", 7, { state: "closed" });
    w.add("cross-parent", 8, { state: "closed" });
    const unblocked = (await run("item.load", { context: {}, deps: w.deps("c") }) as Extract<TaskResult, { status: "pass" }>).output as ItemContext;
    expect(await run("item.dependenciesMet", { context: ctx(unblocked) })).toEqual({ status: "pass" });
  });

  test("createChild rejects invalid, unavailable and excluded dependencies before creating a child", async () => {
    const cases: Array<{ dependsOn: number[]; expected: RegExp; setup?: (w: Awaited<ReturnType<typeof world>>) => void }> = [
      { dependsOn: [0], expected: /Invalid dependsOn value 0: it must be a positive integer/i },
      { dependsOn: [1.5], expected: /Invalid dependsOn value 1.5: it must be a positive integer/i },
      { dependsOn: [5], expected: /Invalid dependsOn value 5: it must not identify the current parent/i },
      { dependsOn: [6], expected: /Invalid dependsOn value 6: it must identify an open, Conveyor-enrolled issue in this repository/i },
      { dependsOn: [7], expected: /Invalid dependsOn value 7: issue #7 is closed/i, setup: (w) => w.add("closed", 7, { state: "closed" }) },
      { dependsOn: [8], expected: /Invalid dependsOn value 8: issue #8 is not enrolled in Conveyor/i, setup: (w) => w.add("unenrolled", 8, { labels: [] }) },
      { dependsOn: [9], expected: /Invalid dependsOn value 9: issue #9 belongs to another repository/i, setup: (w) => {
        w.store.upsertRepository({ id: "other", configName: "other", source: "github", address: "o/other", folder: "/other", configHash: "h" });
        w.store.upsertIssue({ id: "elsewhere", repositoryId: "other", sourceNumber: 9, sourceUrl: "https://x/9", title: "Elsewhere", body: "", sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z" });
      } },
    ];
    for (const { dependsOn, expected, setup } of cases) {
      const w = await world(); w.add("i1", 5); setup?.(w);
      const attempt = tool("item.createChild", w.deps(), {
        title: "Kid", body: "Body", acceptanceCriteria: [{ id: "a", text: "Do" }], dependsOn,
      });
      await expect(attempt).rejects.toThrow(ToolRequestError);
      await expect(attempt).rejects.toThrow(expected);
      expect(w.calls).toEqual([]);
    }
  });

  test("createChild revalidates stored blockers against their live source state before creating a child", async () => {
    for (const [liveState, message] of [
      [{ state: "closed" }, "issue #7 is closed"],
      [{ labels: [] as string[] }, "issue #7 is not enrolled in Conveyor"],
    ] as const) {
      const w = await world(); w.add("i1", 5); w.add("blocker", 7);
      w.updateLiveSource(7, liveState);

      await expect(tool("item.createChild", w.deps(), {
        title: "Kid", body: "Body", acceptanceCriteria: [{ id: "a", text: "Do" }], dependsOn: [7],
      })).rejects.toThrow(`Invalid dependsOn value 7: ${message}`);
      expect(w.calls.map(([name]) => name)).toEqual(["getIssue"]);
    }
  });

  test("createChild rejects blockers that would form parent roll-up cycles before creating a child", async () => {
    const dependencyCycle = await world(); dependencyCycle.add("i1", 5); dependencyCycle.add("blocker", 7);
    dependencyCycle.store.replaceRelationships("blocker", null, ["i1"]);
    await expect(tool("item.createChild", dependencyCycle.deps(), {
      title: "Kid", body: "Body", acceptanceCriteria: [{ id: "a", text: "Do" }], dependsOn: [7],
    })).rejects.toThrow("Invalid dependsOn value 7: it would form a dependency cycle");
    expect(dependencyCycle.calls).toEqual([]);

    const ancestorCycle = await world(); ancestorCycle.add("i1", 5); ancestorCycle.add("ancestor", 7);
    ancestorCycle.store.replaceRelationships("i1", { parentId: "ancestor", siblingOrder: null }, []);
    await expect(tool("item.createChild", ancestorCycle.deps(), {
      title: "Kid", body: "Body", acceptanceCriteria: [{ id: "a", text: "Do" }], dependsOn: [7],
    })).rejects.toThrow("Invalid dependsOn value 7: it would form a dependency cycle");
    expect(ancestorCycle.calls).toEqual([]);
  });

  test("createChild rejects the returned child and dependency cycles without writing a link", async () => {
    const self = await world(); self.add("i1", 5); self.add("existing-child", 99);
    await expect(tool("item.createChild", self.deps(), {
      title: "Kid", body: "Body", acceptanceCriteria: [{ id: "a", text: "Do" }], dependsOn: [99],
    })).rejects.toThrow("Invalid dependsOn value 99: it must not identify the child itself");
    expect(self.store.listDependencies("existing-child")).toEqual([]);

    const cycle = await world(); cycle.add("i1", 5); cycle.add("blocker", 7); cycle.add("existing-child", 99);
    cycle.store.replaceRelationships("blocker", null, ["existing-child"]);
    await expect(tool("item.createChild", cycle.deps(), {
      title: "Kid", body: "Body", acceptanceCriteria: [{ id: "a", text: "Do" }], dependsOn: [7],
    })).rejects.toThrow("Invalid dependsOn value 7: it would form a dependency cycle");
    expect(cycle.store.listDependencies("existing-child")).toEqual([]);
  });

  test("createChild retries a failed dependency write against its existing child", async () => {
    const w = await world({ failDependencyWriteOnce: true }); w.add("i1", 5); w.add("blocker", 7);
    const input = { title: "Kid", body: "Body", acceptanceCriteria: [{ id: "a", text: "Do" }], dependsOn: [7] };
    await expect(tool("item.createChild", w.deps(), input)).rejects.toThrow("temporary dependency failure");
    expect(w.calls.map(([name]) => name)).toEqual(["getIssue", "getIssue", "createChildIssue", "setDependencies"]);
    expect(w.calls[2]![1]).toMatchObject({ labels: [] });
    await expect(tool("item.createChild", w.deps(), input)).resolves.toMatchObject({ output: { id: "c", number: 99, dependsOn: [7] } });
    const creates = w.calls.filter(([name]) => name === "createChildIssue");
    expect(creates).toHaveLength(2);
    expect((creates[0]![1] as { body: string }).body).toBe((creates[1]![1] as { body: string }).body);
    expect(w.calls.filter(([name]) => name === "setDependencies")).toHaveLength(2);
    expect(w.calls.filter(([name]) => name === "replaceConveyorLabels")).toHaveLength(1);
  });

  test("createChild retries a failed dependency section write against its existing child", async () => {
    const w = await world({ failDependencySectionWriteOnce: true }); w.add("i1", 5); w.add("blocker", 7);
    const input = { title: "Kid", body: "Body", acceptanceCriteria: [{ id: "a", text: "Do" }], dependsOn: [7] };
    await expect(tool("item.createChild", w.deps(), input)).rejects.toThrow("temporary dependency section failure");
    await expect(tool("item.createChild", w.deps(), input)).resolves.toMatchObject({ output: { id: "c", number: 99, dependsOn: [7] } });
    const creates = w.calls.filter(([name]) => name === "createChildIssue");
    expect(creates).toHaveLength(2);
    expect((creates[0]![1] as { body: string }).body).toBe((creates[1]![1] as { body: string }).body);
    expect(w.calls.filter(([name]) => name === "setDependencies")).toHaveLength(2);
    expect(w.calls.filter(([name]) => name === "updateManagedSection")).toHaveLength(2);
  });

  test("createChild without dependencies stores its parent relationship", async () => {
    for (const dependsOn of [undefined, []]) {
      const w = await world(); w.add("i1", 5);
      const input = { title: "Kid", body: "Body", acceptanceCriteria: [{ id: "a", text: "Do" }] };
      const out = await tool("item.createChild", w.deps(), dependsOn === undefined ? input : { ...input, dependsOn });
      expect(out.output).toMatchObject({ id: "c", number: 99 });
      expect(w.calls.map(([name]) => name)).toEqual(["getIssue", "createChildIssue"]);
      expect(w.store.listChildren("i1").map((child) => child.issueId)).toEqual(["c"]);
      expect(w.store.getIssue("c")).toMatchObject({
        labels: ["conveyor", "conveyor:implementation"],
        body: expect.stringContaining("Do <!-- conveyor:criterion:a -->"),
      });
      const loaded = (await run("item.load", { context: {}, deps: w.deps() }) as Extract<TaskResult, { status: "pass" }>).output as ItemContext;
      expect(loaded.children).toMatchObject([{ id: "c", number: 99, enrolled: true, hasCriteria: true }]);
      expect((await run("item.childrenValid", { context: ctx(loaded) })).status).toBe("pass");
    }
  });

  test("setType writes a type the organization defines, in its own spelling, and keeps it for the dashboard", async () => {
    const w = await world({ refinement: REFINEMENT }); w.add("i1", 5);
    expect((await tool("item.setType", w.deps(), { type: "bug" })).output).toEqual({ type: "Bug" });
    expect(w.calls).toEqual([["setIssueType", ["o/r", 5, "Bug"]]]);
    expect(w.store.getIssue("i1")!.metadata.type).toBe("Bug");
  });

  test("setType rejects an unknown type with the valid ones and writes nothing", async () => {
    const w = await world({ refinement: REFINEMENT }); w.add("i1", 5);
    await expect(tool("item.setType", w.deps(), { type: "Epic" })).rejects.toThrow('Unknown issue type "Epic". Valid issue types: Task, Bug, Feature');
    expect(w.calls).toEqual([]);
    expect(w.store.getIssue("i1")!.metadata.type).toBeNull();
  });

  test("setType and setFields reject repositories without refinement configuration before metadata writes", async () => {
    const w = await world({ types: ["Task"], fields: [EFFORT] }); w.add("i1", 5);
    await expect(tool("item.setType", w.deps(), { type: "Task" })).rejects.toThrow("no refinement configuration");
    await expect(tool("item.setFields", w.deps(), { fields: [{ name: "Effort", value: "Low" }] })).rejects.toThrow("no refinement configuration");
    expect(w.calls).toEqual([]);
    expect(w.store.getIssue("i1")!.metadata).toEqual({ type: null, fields: {} });
  });

  test("setType reports types as unavailable, without failing, for an owner that has none", async () => {
    for (const types of [null, []]) {
      const w = await world({ refinement: REFINEMENT, types }); w.add("i1", 5);
      const out = await tool("item.setType", w.deps(), { type: "Bug" });
      expect(out.output).toEqual({ unavailable: true, reason: "issue types are not available for o" });
      expect(w.calls).toEqual([]);
    }
  });

  test("setFields writes configured single-select and date-checked fields in the organization's spelling", async () => {
    const w = await world({ refinement: { ...REFINEMENT, fields: ["Effort", "Priority", "Target date"] } }); w.add("i1", 5);
    const out = await tool("item.setFields", w.deps(), { fields: [{ name: "effort", value: "low" }] });
    expect(out.output).toEqual({ fields: { Effort: "Low" } });
    expect(w.calls).toEqual([["setIssueFieldValues", ["o/r", 5, [{ fieldId: 11, name: "Effort", value: "Low" }]]]]);
    expect(w.store.getIssue("i1")!.metadata.fields).toEqual({ Effort: "Low" });
    await tool("item.setFields", w.deps(), { fields: [{ name: "Target date", value: "2026-10-31" }] });
    expect(w.store.getIssue("i1")!.metadata.fields).toEqual({ Effort: "Low", "Target date": "2026-10-31" });
  });

  test("setFields rejects unconfigured, undefined, unknown-option and malformed-date writes and leaves values unchanged", async () => {
    const w = await world({ refinement: { ...REFINEMENT, fields: ["Effort", "Target date", "Missing"] } }); w.add("i1", 5);
    w.store.setIssueMetadata("i1", { fields: { Effort: "High" } });
    const write = (name: string, value: string) => tool("item.setFields", w.deps(), { fields: [{ name, value }] });
    await expect(write("Priority", "High")).rejects.toThrow('Field "Priority" is not writable by refinement in this repository. Writable fields: Effort, Target date, Missing');
    await expect(write("Missing", "x")).rejects.toThrow('The organization does not define a field named "Missing". Defined fields: Effort, Target date, Priority');
    await expect(write("Effort", "Huge")).rejects.toThrow('"Huge" is not an option of Effort. Valid options: High, Medium, Low');
    await expect(write("Target date", "31/10/2026")).rejects.toThrow("not a valid date for Target date. Use YYYY-MM-DD");
    await expect(write("Target date", "2026-02-30")).rejects.toThrow("not a valid date");
    await expect(tool("item.setFields", w.deps(), { fields: [{ name: "Effort", value: "Low" }, { name: "Effort", value: "High" }] })).rejects.toThrow("more than once");
    expect(w.calls).toEqual([]);
    expect(w.store.getIssue("i1")!.metadata.fields).toEqual({ Effort: "High" });
  });

  test("setFields refuses everything when the repository configures no writable fields, and is nonfatal when the owner defines none", async () => {
    const none = await world({ refinement: { fields: [], require: { type: false, fields: [], section: false } } }); none.add("i1", 5);
    await expect(tool("item.setFields", none.deps(), { fields: [{ name: "Effort", value: "Low" }] })).rejects.toThrow("not writable");
    const noFields = await world({ refinement: REFINEMENT, fields: null }); noFields.add("i1", 5);
    expect((await tool("item.setFields", noFields.deps(), { fields: [{ name: "Effort", value: "Low" }] })).output)
      .toEqual({ unavailable: true, reason: "issue fields are not available for o" });
    await expect(tool("item.setFields", noFields.deps(), { fields: [{ name: "Start date", value: "2026-01-01" }] })).rejects.toThrow("not writable");
    expect(noFields.calls).toEqual([]);
  });

  test("setRefinement writes only the managed refinement section, with a heading and every part", async () => {
    const w = await world(); w.add("i1", 5);
    const out = await tool("item.setRefinement", w.deps(), {
      summary: "One release.", inScope: ["Tools"], outOfScope: ["Dates"], areas: ["src/tasks/item.ts"],
      coupling: ["#111 edits the renderer; ordered after it"], parallelChildren: ["#2 and #3"], risks: ["Org lacks types"], verification: ["Unit tests"],
    });
    expect(out.output).toMatchObject({ revision: expect.any(String) });
    const written = w.calls[1]![1] as { section: string; markdown: string };
    expect(written.section).toBe("refinement");
    expect(written.markdown).toBe([
      "## Refinement", "", "One release.", "", "**In scope**", "- Tools", "", "**Out of scope**", "- Dates", "",
      "**Areas and files expected to change**", "- src/tasks/item.ts", "", "**Coupling with other open issues**",
      "- #111 edits the renderer; ordered after it", "", "**Children that can run in parallel**", "- #2 and #3", "",
      "**Main risks**", "- Org lacks types", "", "**Verification**", "- Unit tests",
    ].join("\n"));
    await expect(tool("item.setRefinement", w.deps(), { summary: "  " })).rejects.toThrow();
    await expect(tool("item.setRefinement", w.deps(), { summary: "x <!-- conveyor:refinement:end -->" })).rejects.toThrow("markers");
  });

  test("createChild accepts type, fields and a Refinement section in one call", async () => {
    const w = await world({ refinement: REFINEMENT }); w.add("i1", 5);
    const out = await tool("item.createChild", w.deps(), {
      title: "Kid", body: "Body", acceptanceCriteria: [{ id: "a", text: "Do" }], type: "feature",
      fields: [{ name: "Effort", value: "Medium" }], refinement: { summary: "Small slice." },
    });
    expect(out.output).toMatchObject({ id: "c", number: 99, type: "Feature", fields: { Effort: "Medium" } });
    const created = w.calls[1]![1] as { body: string; type: string; fields: unknown[] };
    expect(created.type).toBe("Feature");
    expect(created.fields).toEqual([{ fieldId: 11, name: "Effort", value: "Medium" }]);
    expect(created.body).toContain("## Acceptance Criteria");
    expect(created.body).toContain("<!-- conveyor:refinement:start -->\n## Refinement\n\nSmall slice.\n<!-- conveyor:refinement:end -->");
  });

  test("createChild with an invalid type or field value creates no child", async () => {
    const w = await world({ refinement: REFINEMENT }); w.add("i1", 5);
    const child = { title: "Kid", body: "Body", acceptanceCriteria: [{ id: "a", text: "Do" }] };
    await expect(tool("item.createChild", w.deps(), { ...child, type: "Epic" })).rejects.toThrow("Unknown issue type");
    await expect(tool("item.createChild", w.deps(), { ...child, fields: [{ name: "Effort", value: "Huge" }] })).rejects.toThrow("not an option");
    await expect(tool("item.createChild", w.deps(), { ...child, fields: [{ name: "Target date", value: "2026-01-01" }] })).rejects.toThrow("not writable");
    expect(w.calls).toEqual([]);
  });

  test("createChild skips a type the owner does not offer and says so", async () => {
    const w = await world({ refinement: REFINEMENT, types: null }); w.add("i1", 5);
    const out = await tool("item.createChild", w.deps(), { title: "Kid", body: "B", acceptanceCriteria: [{ id: "a", text: "Do" }], type: "Task" });
    expect(out.output).toMatchObject({ id: "c", number: 99, unavailable: ["issue types are not available for o"] });
    expect(w.calls[1]![1]).not.toHaveProperty("type");
  });

  test("tool input is validated", async () => {
    const w = await world(); w.add("i1", 5);
    await expect(tool("item.createChild", w.deps(), { title: "Kid", body: "b", acceptanceCriteria: [] })).rejects.toThrow();
    await expect(tool("item.setParent", w.deps(), { parentNumber: -1 })).rejects.toThrow();
    await expect(tool("item.setTitle", w.deps(), { title: "   " })).rejects.toThrow();
    await expect(tool("item.setTitle", w.deps(), { title: "x".repeat(257) })).rejects.toThrow();
    expect(w.calls).toEqual([]);
  });
});

describe("work breakdown tasks", () => {
  type PlannedEntry = {
    id: string;
    title: string;
    scope: string;
    acceptanceCriteria: Array<{ id: string; text: string }>;
    dependsOn: string[];
    covers: string[];
    systemLabels: string[];
  };
  type SplitPlan = { decision: "split"; review: "proposed" | "approved" | "rejected"; reason?: string; entries: PlannedEntry[] };
  const splitPlan = (review: SplitPlan["review"] = "approved"): SplitPlan => ({
    decision: "split",
    review,
    entries: [
      { id: "api", title: "API child", scope: "Add the API.", acceptanceCriteria: [{ id: "api-criterion", text: "The API works." }], dependsOn: [], covers: ["parent-api"], systemLabels: ["area:api"] },
      { id: "ui", title: "UI child", scope: "Add the UI.", acceptanceCriteria: [{ id: "ui-criterion", text: "The UI works." }], dependsOn: ["api"], covers: ["parent-ui"], systemLabels: ["area:ui"] },
    ],
  });
  const storedPlanBody = (plan: BreakdownPlan) => {
    const parent = criteriaBody("- [ ] Parent API <!-- conveyor:criterion:parent-api -->", "- [ ] Parent UI <!-- conveyor:criterion:parent-ui -->");
    return upsertManagedSection(parent, "breakdown", renderBreakdownPlan(plan), parseManagedSections(parent).revision);
  };
  const childBody = (entry: PlannedEntry) => {
    let body = upsertManagedSection("", "description", `## Scope\n\n${entry.scope}`, parseManagedSections("").revision);
    body = upsertManagedSection(body, "acceptance-criteria", renderAcceptanceCriteriaSection(entry.acceptanceCriteria), parseManagedSections(body).revision);
    const marker = createHash("sha256").update(`breakdown:i1:${entry.id}`).digest("hex");
    return `${body.trimEnd()}\n\n<!-- conveyor:breakdown-entry:${entry.id} -->\n<!-- conveyor:child-create:${marker} -->\n`;
  };

  test("returns incomplete and rejected plans to refinement with their actionable reason", async () => {
    const incomplete = { ...splitPlan(), entries: [{ ...splitPlan().entries[0]!, covers: ["missing"] }] };
    const incompleteResult = await run("breakdown.planComplete", {
      context: ctx({ criteria: [{ id: "parent-api", text: "A", manual: false }], breakdown: renderBreakdownPlan(incomplete) }, { systemLabels: ["area:api", "area:ui"] }),
    });
    expect(incompleteResult).toMatchObject({ status: "fail", message: expect.stringContaining("covers unknown parent criterion missing") });

    const rejectedResult = await run("breakdown.reviewed", {
      context: ctx({ criteria: [{ id: "parent-api", text: "A", manual: false }, { id: "parent-ui", text: "U", manual: false }], breakdown: renderBreakdownPlan({ ...splitPlan(), review: "rejected", reason: "Separate the API contract from the UI scope." }) }, { systemLabels: ["area:api", "area:ui"] }),
    });
    expect(rejectedResult).toEqual({ status: "fail", message: "Work breakdown plan was rejected: Separate the API contract from the UI scope." });
  });

  test("rejects duplicate dependency and system-label values before review", async () => {
    const w = await world({ pipelineStages: ["refinement", "refinement-review", "work-breakdown", "implementation"] });
    w.add("i1", 1, { body: storedPlanBody(splitPlan()) });
    const duplicated = splitPlan();
    duplicated.entries[1] = { ...duplicated.entries[1]!, dependsOn: ["api", "api"], systemLabels: ["area:ui", "area:ui"] };

    await expect(runAt("breakdown.setPlan", "refinement", {
      context: {}, deps: w.deps(), input: { decision: "split", entries: duplicated.entries }, actor: "agent",
    })).rejects.toThrow("entry ui has duplicate dependency IDs; entry ui has duplicate system labels");
  });

  test("detects missing and mismatched children, uncovered criteria, and invalid dependency references", async () => {
    const plan = splitPlan();
    const validChildren = plan.entries.map((entry, index) => ({
      id: `child-${entry.id}`, number: index + 2, state: "open", enrolled: true, hasCriteria: true, hasChildren: false,
      title: entry.title, body: childBody(entry), labels: ["conveyor", ...entry.systemLabels], dependsOn: index === 0 ? [] : [2],
    }));
    const context = (children: ItemContext["children"], breakdown: BreakdownPlan = plan) => ctx({
      criteria: [{ id: "parent-api", text: "A", manual: false }, { id: "parent-ui", text: "U", manual: false }],
      breakdown: renderBreakdownPlan(breakdown), children,
    }, { systemLabels: ["area:api", "area:ui"] });

    expect((await run("breakdown.complete", { context: context(validChildren) })).status).toBe("pass");
    expect(await run("breakdown.complete", { context: context(validChildren.slice(0, 1)) })).toMatchObject({ status: "fail", message: expect.stringContaining("entry ui has no created child") });
    expect(await run("breakdown.complete", { context: context([{ ...validChildren[0]!, title: "Wrong title" }, validChildren[1]!] ) })).toMatchObject({ status: "fail", message: expect.stringContaining("entry api child title does not match") });

    const uncovered = { ...splitPlan(), entries: [{ ...splitPlan().entries[0]!, covers: ["parent-api"] }] };
    expect(await run("breakdown.complete", { context: context([], uncovered) })).toMatchObject({ status: "fail", message: expect.stringContaining("parent criterion parent-ui is not covered") });
    const invalidDependency = { ...splitPlan(), entries: [{ ...splitPlan().entries[0]!, dependsOn: ["unknown"] }, splitPlan().entries[1]!] };
    expect(await run("breakdown.complete", { context: context([], invalidDependency) })).toMatchObject({ status: "fail", message: expect.stringContaining("depends on unknown entry unknown") });
  });

  test("reuses marked children after an interrupted creation and starts them at implementation", async () => {
    const w = await world({ pipelineStages: ["refinement", "refinement-review", "work-breakdown", "implementation"], breakdownFailAfterCreates: 1 });
    w.add("i1", 1, { body: storedPlanBody(splitPlan()) });

    await expect(runAt("breakdown.createChildren", "work-breakdown", { context: {}, deps: w.deps(), input: {}, actor: "agent" })).rejects.toThrow("interrupted child creation");
    const rerun = await runAt("breakdown.createChildren", "work-breakdown", { context: {}, deps: w.deps(), input: {}, actor: "agent" }) as Extract<TaskResult, { status: "pass" }>;

    expect(rerun.output).toEqual({ decision: "split", children: [{ entryId: "api", number: 100 }, { entryId: "ui", number: 101 }] });
    expect(w.calls.filter(([name]) => name === "createChildIssue")).toHaveLength(4);
    expect(w.source(100).labels).toContain("conveyor:implementation");
    const loaded = (await run("item.load", { context: {}, deps: w.deps() }) as Extract<TaskResult, { status: "pass" }>).output as ItemContext;
    expect((await run("breakdown.complete", { context: ctx(loaded, { systemLabels: ["area:api", "area:ui"] }) })).status).toBe("pass");
  });

  test("keeps a reused child's later stage while enrolling an unenrolled sibling", async () => {
    const w = await world({ pipelineStages: ["refinement", "refinement-review", "work-breakdown", "implementation", "review"], breakdownFailAfterCreates: 99 });
    w.add("i1", 1, { body: storedPlanBody(splitPlan()) });

    await runAt("breakdown.createChildren", "work-breakdown", { context: {}, deps: w.deps(), input: {}, actor: "agent" });
    w.updateLiveSource(100, { labels: ["area:api", "conveyor:review"] });
    w.updateLiveSource(101, { labels: ["area:ui"] });

    await runAt("breakdown.createChildren", "work-breakdown", { context: {}, deps: w.deps(), input: {}, actor: "agent" });

    expect(w.source(100).labels).toContain("conveyor:review");
    expect(w.source(100).labels).not.toContain("conveyor:implementation");
    expect(w.source(101).labels).toEqual(expect.arrayContaining(["conveyor", "conveyor:implementation"]));
  });

  test("returns a split plan to refinement when the live parent becomes no-split", async () => {
    const w = await world({ pipelineStages: ["refinement", "refinement-review", "work-breakdown", "implementation"] });
    w.add("i1", 1, { body: storedPlanBody(splitPlan()), labels: ["conveyor", "conveyor:no-split"] });

    const result = await runAt("breakdown.createChildren", "work-breakdown", { context: {}, deps: w.deps(), input: {}, actor: "agent" }) as Extract<TaskResult, { status: "pass" }>;

    expect(result.output).toEqual({ decision: "split", returnedToRefinement: true, reason: "This item carries the conveyor:no-split label and must remain one item." });
    expect(w.calls.some(([name]) => name === "createChildIssue")).toBe(false);
    expect(parseBreakdownPlan(w.source(1).body)).toMatchObject({ review: "rejected", reason: expect.stringContaining("must remain one item") });
  });

  test("records dependency links before enrolling any created child", async () => {
    const w = await world({ pipelineStages: ["refinement", "refinement-review", "work-breakdown", "implementation"], breakdownFailAfterCreates: 99 });
    w.add("i1", 1, { body: storedPlanBody(splitPlan()) });

    await runAt("breakdown.createChildren", "work-breakdown", { context: {}, deps: w.deps(), input: {}, actor: "agent" });

    const callNames = w.calls.map(([name]) => name);
    expect(callNames.indexOf("replaceConveyorLabels")).toBeGreaterThan(callNames.lastIndexOf("setDependencies"));
    const created = w.calls.filter(([name]) => name === "createChildIssue").map(([, input]) => input as { labels: string[] });
    expect(created).toEqual([
      expect.objectContaining({ labels: ["area:api"] }),
      expect.objectContaining({ labels: ["area:ui"] }),
    ]);
  });

  test("uses a configured child start stage instead of the adjacent stage", async () => {
    const w = await world({
      pipelineStages: ["refinement", "refinement-review", "work-breakdown", "implementation", "verify"],
      childrenStartAt: "verify",
      breakdownFailAfterCreates: 99,
    });
    w.add("i1", 1, { body: storedPlanBody(splitPlan()) });

    await runAt("breakdown.createChildren", "work-breakdown", { context: {}, deps: w.deps(), input: {}, actor: "agent" });

    expect(w.source(100).labels).toContain("conveyor:verify");
    expect(w.source(100).labels).not.toContain("conveyor:implementation");
  });

  test("passes a reviewed no-split plan without creating a child", async () => {
    const w = await world({ pipelineStages: ["refinement", "refinement-review", "work-breakdown", "implementation"] });
    const parent = criteriaBody("- [ ] Keep it whole <!-- conveyor:criterion:whole -->");
    w.add("i1", 1, { body: upsertManagedSection(parent, "breakdown", renderBreakdownPlan({ decision: "no-split", review: "approved" }), parseManagedSections(parent).revision) });

    const created = await runAt("breakdown.createChildren", "work-breakdown", { context: {}, deps: w.deps(), input: {}, actor: "agent" }) as Extract<TaskResult, { status: "pass" }>;
    expect(created.output).toEqual({ decision: "no-split", children: [] });
    expect(w.calls.some(([name]) => name === "createChildIssue")).toBe(false);
    const loaded = (await run("item.load", { context: {}, deps: w.deps() }) as Extract<TaskResult, { status: "pass" }>).output as ItemContext;
    expect((await run("breakdown.complete", { context: ctx(loaded, { systemLabels: ["area:api", "area:ui"] }) })).status).toBe("pass");
  });
});
