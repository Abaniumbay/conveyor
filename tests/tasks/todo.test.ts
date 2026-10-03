import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorStore } from "../../src/db/store";
import { ItemTodos, summarizeTodos } from "../../src/engine/todos";
import { createTaskRegistry } from "../../src/tasks/catalogue";
import { runTask, type TaskResult } from "../../src/tasks/contract";
import type { TaskDeps } from "../../src/tasks/deps";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const registry = createTaskRegistry();

async function world() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-todo-"));
  directories.push(root);
  const store = await ConveyorStore.open(path.join(root, "db.sqlite"));
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "o/r", folder: "/f", configHash: "h" });
  store.upsertIssue({
    id: "i1", repositoryId: "repo", sourceNumber: 1, sourceUrl: "https://x/1", title: "Issue 1",
    body: "", sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  const deps = {
    store, issueId: "i1", clock: () => new Date("2026-10-03T10:00:00Z"), run: { id: "run-1", actor: null },
  } as unknown as TaskDeps;
  const call = (name: string, input: unknown) =>
    runTask(registry.require(name), { config: {}, context: {}, deps, input, actor: "kaveh", instance: { id: name, stage: "implementation", idempotencyKey: "k", resumed: false } } as never) as Promise<TaskResult>;
  return { store, call };
}

const output = (result: TaskResult) => (result as Extract<TaskResult, { status: "pass" }>).output as { items: Array<Record<string, unknown>>; summary: unknown };

describe("todo tools", () => {
  test("are tools; set and update write state on every call instead of replaying a journaled response", () => {
    expect(registry.require("todo.get")).toMatchObject({ kind: "tool", invalidates: [] });
    expect(registry.require("todo.get").mutating).toBeFalsy();
    for (const name of ["todo.set", "todo.update"]) {
      expect(registry.require(name)).toMatchObject({ kind: "tool", mutating: true, journal: false });
    }
  });

  test("an item starts with an empty list", async () => {
    const w = await world();
    expect(output(await w.call("todo.get", {}))).toEqual({ items: [], summary: null });
  });

  test("set replaces the list, defaults status to pending and records the run; get reads it back with progress", async () => {
    const w = await world();
    const set = await w.call("todo.set", { items: [
      { id: "t1", text: "Shared Category repository", status: "done" },
      { id: "t2", text: "Tenant family settings endpoint", status: "in_progress", note: "admin auth first" },
      { id: "t3", text: "Lobby picker uses the family list" },
    ] });
    expect(set.status).toBe("pass");
    expect(output(await w.call("todo.get", {}))).toEqual({
      items: [
        { id: "t1", text: "Shared Category repository", status: "done" },
        { id: "t2", text: "Tenant family settings endpoint", status: "in_progress", note: "admin auth first" },
        { id: "t3", text: "Lobby picker uses the family list", status: "pending" },
      ],
      summary: { done: 1, total: 3, current: "Tenant family settings endpoint" },
    });
    expect(new ItemTodos(w.store.sqlite()).get("i1")).toMatchObject({ runId: "run-1", updatedAt: "2026-10-03T10:00:00.000Z" });
  });

  test("update changes one item's status or note, and the same update can be applied again", async () => {
    const w = await world();
    await w.call("todo.set", { items: [{ id: "t1", text: "A" }, { id: "t2", text: "B", note: "old" }] });
    for (let round = 0; round < 2; round += 1) {
      expect((await w.call("todo.update", { id: "t1", status: "in_progress" })).status).toBe("pass");
      expect((await w.call("todo.update", { id: "t1", status: "done" })).status).toBe("pass");
    }
    await w.call("todo.update", { id: "t2", note: "" });
    expect(output(await w.call("todo.get", {})).items).toEqual([
      { id: "t1", text: "A", status: "done" },
      { id: "t2", text: "B", status: "pending" },
    ]);
  });

  test("refuses duplicate ids, a second in_progress item and unknown ids", async () => {
    const w = await world();
    expect(await w.call("todo.set", { items: [{ id: "t1", text: "A" }, { id: "t1", text: "B" }] })).toEqual({ status: "fail", message: 'todo id "t1" is used twice' });
    expect(await w.call("todo.set", { items: [{ id: "a", text: "A", status: "in_progress" }, { id: "b", text: "B", status: "in_progress" }] }))
      .toEqual({ status: "fail", message: "at most one todo can be in_progress" });
    await w.call("todo.set", { items: [{ id: "a", text: "A", status: "in_progress" }, { id: "b", text: "B" }] });
    expect(await w.call("todo.update", { id: "b", status: "in_progress" })).toEqual({ status: "fail", message: "at most one todo can be in_progress" });
    expect((await w.call("todo.update", { id: "zz", status: "done" })).status).toBe("fail");
    expect(output(await w.call("todo.get", {})).items.map((item) => item.status)).toEqual(["in_progress", "pending"]);
  });

  test("input is validated", async () => {
    const w = await world();
    await expect(w.call("todo.set", { items: Array.from({ length: 41 }, (_, i) => ({ id: `t${i}`, text: "x" })) })).rejects.toThrow();
    await expect(w.call("todo.set", { items: [{ id: "t1", text: "" }] })).rejects.toThrow();
    await expect(w.call("todo.update", { id: "t1" })).rejects.toThrow();
  });
});

describe("summarizeTodos", () => {
  test("counts done items and names the item in progress, else the next pending one", () => {
    expect(summarizeTodos([])).toBeNull();
    expect(summarizeTodos([{ id: "a", text: "A", status: "done" }, { id: "b", text: "B", status: "pending" }])).toEqual({ done: 1, total: 2, current: "B" });
    expect(summarizeTodos([{ id: "a", text: "A", status: "done" }])).toEqual({ done: 1, total: 1, current: null });
  });
});
