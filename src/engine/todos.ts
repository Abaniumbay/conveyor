// The implementer's todo list for an item. Conveyor owns it: agents change it only through the
// todo tools, it survives across runs and returns to the stage, and the board shows its progress.

import type { Database } from "bun:sqlite";

export type TodoStatus = "pending" | "in_progress" | "done";

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
  done: number;
  total: number;
  /** The item in progress, or else the next pending one; null when every item is done. */
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
    this.#db
      .query(`INSERT INTO item_todos(issue_id, items_json, run_id, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(issue_id) DO UPDATE SET items_json = excluded.items_json, run_id = excluded.run_id, updated_at = excluded.updated_at`)
      .run(issueId, JSON.stringify(items), runId, at);
  }
}

export function summarizeTodos(items: readonly TodoItem[]): TodoSummary | null {
  if (items.length === 0) return null;
  const current = items.find((item) => item.status === "in_progress") ?? items.find((item) => item.status === "pending");
  return { done: items.filter((item) => item.status === "done").length, total: items.length, current: current?.text ?? null };
}
