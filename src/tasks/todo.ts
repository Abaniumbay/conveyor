// The `todo` task group: the implementer's todo list for the current item. The list is stored by
// Conveyor (not in the repository), kept across runs and returns, and shown as progress on the board.

import { z } from "zod";

import { defineGroup, fail, pass, type TaskDefinition } from "./contract";
import type { TaskDeps } from "./deps";
import { ItemTodos, summarizeTodos, type TodoItem } from "../engine/todos";

const MAX_UNFINISHED_ITEMS = 40;

const statusSchema = z.enum(["pending", "in_progress", "done", "skipped"]);
const itemSchema = z.object({
  id: z.string().trim().min(1).max(40),
  text: z.string().trim().min(1).max(200),
  status: statusSchema.default("pending"),
  note: z.string().trim().max(500).optional(),
}).strict();

export const todoSetInput = z.object({ items: z.array(itemSchema) }).strict();
export const todoUpdateInput = z.object({
  id: z.string().trim().min(1),
  status: statusSchema.optional(),
  note: z.string().trim().max(500).optional(),
}).strict().refine((input) => input.status !== undefined || input.note !== undefined, "give a status, a note or both");

type Deps = TaskDeps;

const todosOf = (deps: Deps) => new ItemTodos(deps.store.sqlite());
const now = (deps: Deps) => (deps.clock?.() ?? new Date()).toISOString();

function view(items: readonly TodoItem[]) {
  return { items, summary: summarizeTodos(items) };
}

/** A list is valid when ids are unique and at most one item is in progress. */
function problems(items: readonly TodoItem[]): string | null {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) return `todo id "${item.id}" is used twice`;
    ids.add(item.id);
  }
  if (items.filter((item) => item.status === "in_progress").length > 1) return "at most one todo can be in_progress";
  return null;
}

function unfinishedItemLimitProblem(items: readonly TodoItem[]): string | null {
  if (items.filter((item) => item.status === "pending" || item.status === "in_progress").length > MAX_UNFINISHED_ITEMS) {
    return `at most ${MAX_UNFINISHED_ITEMS} pending or in_progress todos are allowed`;
  }
  return null;
}

function replacementProblem(current: readonly TodoItem[], next: readonly TodoItem[]): string | null {
  const nextById = new Map(next.map((item) => [item.id, item]));
  const missingTerminalIds = current
    .filter((item) => (item.status === "done" || item.status === "skipped") && !nextById.has(item.id))
    .map((item) => `"${item.id}"`);
  if (missingTerminalIds.length > 0) {
    return `completed todo ids must be kept: ${missingTerminalIds.join(", ")}; keep completed items and add new work under new ids`;
  }

  for (const item of current) {
    const replacement = nextById.get(item.id);
    if (replacement && replacement.text !== item.text) return `todo id "${item.id}" must keep its original text`;
    if (item.status === "done" && replacement?.status !== "done") return `completed todo id "${item.id}" must remain done`;
    if (item.status === "skipped" && (!replacement || replacement.status !== "skipped" || replacement.note !== item.note)) {
      return `skipped todo id "${item.id}" is Conveyor history and must remain unchanged`;
    }
  }
  for (const item of next) {
    if (item.status === "skipped" && current.find((currentItem) => currentItem.id === item.id)?.status !== "skipped") {
      return `skipped todo id "${item.id}" can only be created by Conveyor`;
    }
  }
  return null;
}

const get: TaskDefinition<unknown, unknown, Deps> = {
  name: "todo.get",
  kind: "tool",
  description: "Read the current item's todo list (kept across runs and returns), with finished/total progress and skipped history.",
  reads: [],
  writes: [],
  invalidates: [],
  input: z.object({}).strict(),
  run({ deps }) {
    return pass(view(todosOf(deps).get(deps.issueId)?.items ?? []));
  },
};

const set: TaskDefinition<unknown, z.output<typeof todoSetInput>, Deps> = {
  name: "todo.set",
  kind: "tool",
  description: `Replace the current item's whole todo list: ordered items with a stable id, a short text and a status (pending, in_progress, done). Retain existing completed and Conveyor-skipped history with their ids unchanged; after feedback add new ids for each required fix, failing CI check, or open finding. At most ${MAX_UNFINISHED_ITEMS} pending or in_progress items and one in_progress.`,
  reads: [],
  writes: [],
  invalidates: [],
  input: todoSetInput,
  mutating: true,
  journal: false,
  run({ deps, input }) {
    const items = input!.items.map(({ note, ...item }) => (note ? { ...item, note } : item));
    const problem = problems(items) ?? unfinishedItemLimitProblem(items);
    if (problem) return fail(problem);
    const todos = todosOf(deps);
    const current = todos.get(deps.issueId)?.items ?? [];
    const replacementError = replacementProblem(current, items);
    if (replacementError) return fail(replacementError);
    todos.set(deps.issueId, items, deps.run?.id ?? null, now(deps));
    return pass(view(items));
  },
};

const update: TaskDefinition<unknown, z.output<typeof todoUpdateInput>, Deps> = {
  name: "todo.update",
  kind: "tool",
  description: "Change one todo's status (pending, in_progress, done) and/or note by id. Conveyor-skipped entries are immutable history. Starting one item moves no other: finish or pause the current one first.",
  reads: [],
  writes: [],
  invalidates: [],
  input: todoUpdateInput,
  mutating: true,
  journal: false,
  run({ deps, input }) {
    const todos = todosOf(deps);
    const current = todos.get(deps.issueId)?.items ?? [];
    if (!current.some((item) => item.id === input!.id)) {
      return fail(`no todo with id "${input!.id}"; read todo.get or replace the list with todo.set`);
    }
    const existing = current.find((item) => item.id === input!.id)!;
    if (existing.status === "skipped") return fail(`skipped todo id "${existing.id}" is Conveyor history and cannot be changed`);
    if (input!.status === "skipped") return fail("skipped status is reserved for Conveyor closeout");
    const items = current.map((item) => {
      if (item.id !== input!.id) return item;
      const next: TodoItem = { ...item, ...(input!.status ? { status: input!.status } : {}) };
      if (input!.note !== undefined) {
        if (input!.note) next.note = input!.note;
        else delete next.note;
      }
      return next;
    });
    const problem = problems(items);
    if (problem) return fail(problem);
    todos.set(deps.issueId, items, deps.run?.id ?? null, now(deps));
    return pass(view(items));
  },
};

export const todoGroup = defineGroup("todo", [get, set, update]);
