import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ItemTodos, TODO_CLOSEOUT_NOTE } from "../../src/engine/todos";
import { migrations } from "../../src/db/migrations";

describe("todo closeout", () => {
  test("skips unfinished entries once and leaves done and skipped entries alone", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE item_todos (issue_id TEXT PRIMARY KEY, items_json TEXT NOT NULL, run_id TEXT, updated_at TEXT NOT NULL)");
    const todos = new ItemTodos(db);
    todos.set("i", [
      { id: "a", text: "A", status: "done", note: "kept" },
      { id: "b", text: "B", status: "pending" },
      { id: "c", text: "C", status: "in_progress", note: "wip" },
      { id: "d", text: "D", status: "skipped", note: "older" },
    ], "run", "2026-10-01T00:00:00Z");
    todos.closeOut("i");
    const closed = todos.get("i")!.items;
    expect(closed).toEqual([
      { id: "a", text: "A", status: "done", note: "kept" },
      { id: "b", text: "B", status: "skipped", note: TODO_CLOSEOUT_NOTE },
      { id: "c", text: "C", status: "skipped", note: TODO_CLOSEOUT_NOTE },
      { id: "d", text: "D", status: "skipped", note: "older" },
    ]);
    todos.closeOut("i");
    expect(todos.get("i")!.items).toEqual(closed);
  });

  test("the migration closes lists of items past implementation or done, once", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE issues (id TEXT PRIMARY KEY, projected_stage TEXT, projected_state TEXT)");
    db.exec("CREATE TABLE item_todos (issue_id TEXT PRIMARY KEY, items_json TEXT NOT NULL, run_id TEXT, updated_at TEXT NOT NULL)");
    const open = JSON.stringify([{ id: "a", text: "A", status: "done" }, { id: "b", text: "B", status: "pending" }]);
    for (const [id, stage, state] of [["impl", "implementation", "active"], ["review", "review", "active"], ["done", "deploy", "done"], ["completed", "implementation", "completed"]] as [string, string, string][]) {
      db.query("INSERT INTO issues VALUES (?, ?, ?)").run(id, stage, state);
      db.query("INSERT INTO item_todos VALUES (?, ?, NULL, 'x')").run(id, open);
    }
    const sql = migrations.find((m) => m.version === 17)!.sql;
    db.exec(sql);
    const read = (id: string) => JSON.parse((db.query("SELECT items_json FROM item_todos WHERE issue_id = ?").get(id) as { items_json: string }).items_json);
    expect(read("impl")).toEqual(JSON.parse(open));
    for (const id of ["review", "done", "completed"]) {
      expect(read(id)).toEqual([{ id: "a", text: "A", status: "done" }, { id: "b", text: "B", status: "skipped", note: TODO_CLOSEOUT_NOTE }]);
    }
    db.exec(sql);
    expect(read("review")[1]).toEqual({ id: "b", text: "B", status: "skipped", note: TODO_CLOSEOUT_NOTE });
    expect(read("completed")[1]).toEqual({ id: "b", text: "B", status: "skipped", note: TODO_CLOSEOUT_NOTE });
  });
});
