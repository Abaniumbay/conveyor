// An item's todo list. Conveyor owns it: agents change it only through the todo tools, so who may
// write it is decided by the agents' tool grants. It survives across runs and returns to a stage, and
// every forward move closes out what is unfinished.

import type { Database } from "bun:sqlite";

import { eventLog } from "../events/log";

export type TodoStatus = "pending" | "in_progress" | "done" | "skipped";

export const TODO_CLOSEOUT_NOTE = "Closed by Conveyor when the item moved on to its next stage.";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
  note?: string;
}

export interface TodoList {
  items: TodoItem[];
  runId: string | null;
  updatedAt: string;
}

export interface TodoSummary {
  /** Terminal entries: agent-completed and Conveyor-closed work. */
  finished: number;
  total: number;
  /** Entries closed by Conveyor when the owning stage passed. */
  skipped: number;
  /** The item in progress, or else the next pending one; null when every item is terminal. */
  current: string | null;
}

interface Row { items_json: string; run_id: string | null; updated_at: string }

export class ItemTodos {
  readonly #db: Database;

  constructor(database: Database) {
    this.#db = database;
  }

  get(issueId: string): TodoList | null {
    const row = this.#db.query("SELECT items_json, run_id, updated_at FROM item_todos WHERE issue_id = ?").get(issueId) as Row | null;
    if (!row) return null;
    return { items: JSON.parse(row.items_json) as TodoItem[], runId: row.run_id, updatedAt: row.updated_at };
  }

  /** Replaces the whole list. */
  set(issueId: string, items: readonly TodoItem[], runId: string | null, at: string): void {
    this.#db.transaction(() => {
      this.#db
        .query(`INSERT INTO item_todos(issue_id, items_json, run_id, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(issue_id) DO UPDATE SET items_json = excluded.items_json, run_id = excluded.run_id, updated_at = excluded.updated_at`)
        .run(issueId, JSON.stringify(items), runId, at);
      eventLog(this.#db).append("todo.changed", {}, { issueId });
    })();
  }

  /**
   * Marks every pending or in_progress entry skipped with the closeout note. Done and already skipped
   * entries are untouched, so applying it twice changes nothing.
   */
  closeOut(issueId: string): void {
    const list = this.get(issueId);
    if (!list || !list.items.some((item) => item.status === "pending" || item.status === "in_progress")) return;
    const items = list.items.map((item): TodoItem =>
      item.status === "pending" || item.status === "in_progress" ? { ...item, status: "skipped", note: TODO_CLOSEOUT_NOTE } : item);
    this.#db.transaction(() => {
      this.#db.query("UPDATE item_todos SET items_json = ? WHERE issue_id = ?").run(JSON.stringify(items), issueId);
      eventLog(this.#db).append("todo.changed", {}, { issueId });
    })();
  }
}

export function summarizeTodos(items: readonly TodoItem[]): TodoSummary | null {
  if (items.length === 0) return null;
  const current = items.find((item) => item.status === "in_progress") ?? items.find((item) => item.status === "pending");
  const skipped = items.filter((item) => item.status === "skipped").length;
  return {
    finished: items.filter((item) => item.status === "done" || item.status === "skipped").length,
    total: items.length,
    skipped,
    current: current?.text ?? null,
  };
}
