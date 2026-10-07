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

const REFINEMENT = { fields: ["Effort", "Priority"], require: { type: true, fields: ["Effort"], section: true } };
const EFFORT = { id: 11, name: "Effort", dataType: "single_select", options: ["High", "Medium", "Low"] };
const TARGET = { id: 12, name: "Target date", dataType: "date", options: [] };
const PRIORITY = { id: 13, name: "Priority", dataType: "single_select", options: ["Urgent", "High", "Medium", "Low"] };

async function world(options: { refinement?: typeof REFINEMENT; types?: string[] | null; fields?: unknown[] | null } = {}) {
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
    repositories: { repo: { pipeline: "default", systemLabels: ["area:api", "area:ui"], address: "o/r", ...(options.refinement ? { refinement: options.refinement } : {}) } },
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
    setTitle: async (...a: unknown[]) => { calls.push(["setTitle", a]); },
    listIssueTypes: async () => (options.types === undefined ? ["Task", "Bug", "Feature"] : options.types),
    listIssueFields: async () => (options.fields === undefined ? [EFFORT, TARGET, PRIORITY] : options.fields),
    getIssueFieldValues: async () => ({}),
    setIssueType: async (...a: unknown[]) => { calls.push(["setIssueType", a]); },
    setIssueFieldValues: async (...a: unknown[]) => { calls.push(["setIssueFieldValues", a]); },
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
      refinement: { type: null, typesAvailable: false, fields: {}, definedFields: [], section: false },
    });
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

  test("get and guidance read", async () => {
    const w = await world(); w.add("i1", 5);
    expect((await tool("item.get", w.deps(), {})).output).toMatchObject({ body: "B" });
    expect(w.calls[0]).toEqual(["getIssue", ["o/r", 5]]);
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
    const w = await world(); w.add("i1", 5);
    const out = await tool("item.setCriteria", w.deps(), { criteria: [{ id: "a", text: "First" }] });
    expect(out.output).toEqual({ revision: "rev:updated" });
    expect(w.calls[1]).toEqual(["updateManagedSection", {
      address: "o/r", issueNumber: 5, section: "acceptance-criteria",
      markdown: "## Acceptance Criteria\n\n- [ ] First <!-- conveyor:criterion:a -->", expectedRevision: "rev:B",
    }]);
  });

  test("setTitle replaces the current issue's title, trimmed", async () => {
    const w = await world(); w.add("i1", 5);
    expect((await tool("item.setTitle", w.deps(), { title: "  Players pick categories per family  " })).output).toEqual({ title: "Players pick categories per family" });
    expect(w.calls).toEqual([["setTitle", ["o/r", 5, "Players pick categories per family"]]]);
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
    expect(out.output).toEqual({ revision: "rev:updated" });
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
    expect(out.output).toEqual({ id: "c", number: 99, type: "Feature", fields: { Effort: "Medium" } });
    const created = w.calls[0]![1] as { body: string; type: string; fields: unknown[] };
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
    expect(out.output).toEqual({ id: "c", number: 99, unavailable: ["issue types are not available for o"] });
    expect(w.calls[0]![1]).not.toHaveProperty("type");
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
