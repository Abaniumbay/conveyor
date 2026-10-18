import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ItemTodos, TODO_CLOSEOUT_NOTE } from "../../src/engine/todos";
import { migrations } from "../../src/db/migrations";

describe("todo closeout", () => {
  test("skips unfinished entries once and leaves done and skipped entries alone", () => {
    const db = new Database(":memory:");
    for (const migration of migrations) db.exec(migration.sql);
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
    // Migration 17 ran on databases that existed then; its note text is fixed history.
    const MIGRATION_17_NOTE = "Closed by Conveyor when the implementation stage passed its gate.";
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
      expect(read(id)).toEqual([{ id: "a", text: "A", status: "done" }, { id: "b", text: "B", status: "skipped", note: MIGRATION_17_NOTE }]);
    }
    db.exec(sql);
    expect(read("review")[1]).toEqual({ id: "b", text: "B", status: "skipped", note: MIGRATION_17_NOTE });
    expect(read("completed")[1]).toEqual({ id: "b", text: "B", status: "skipped", note: MIGRATION_17_NOTE });
  });

  test("a list belongs to the stage of the run that wrote it and is closed out only when that stage is left", () => {
    const db = new Database(":memory:");
    for (const migration of migrations) db.exec(migration.sql);
    db.exec("INSERT INTO runs(id, issue_id, stage_id, attempt, kind, status, config_hash, started_at) VALUES ('run-build', 'i', 'build', 1, 'producer', 'running', 'h', 'x')");
    const todos = new ItemTodos(db);
    todos.set("i", [{ id: "a", text: "A", status: "pending" }], "run-build", "2026-10-01T00:00:00Z");
    expect(todos.get("i")!.stageId).toBe("build");
    todos.closeOutStage("i", "review");
    expect(todos.get("i")!.items[0]!.status).toBe("pending");
    todos.closeOutStage("i", "build");
    expect(todos.get("i")!.items[0]).toEqual({ id: "a", text: "A", status: "skipped", note: TODO_CLOSEOUT_NOTE });
  });

  test("a write without a run keeps the list's stage", () => {
    const db = new Database(":memory:");
    for (const migration of migrations) db.exec(migration.sql);
    db.exec("INSERT INTO runs(id, issue_id, stage_id, attempt, kind, status, config_hash, started_at) VALUES ('run-build', 'i', 'build', 1, 'producer', 'running', 'h', 'x')");
    const todos = new ItemTodos(db);
    todos.set("i", [{ id: "a", text: "A", status: "pending" }], "run-build", "2026-10-01T00:00:00Z");
    todos.set("i", [{ id: "a", text: "A", status: "done" }], null, "2026-10-01T00:01:00Z");
    expect(todos.get("i")!.stageId).toBe("build");
  });

  test("migration 37 gives existing lists the stage of the run that wrote them", () => {
    const db = new Database(":memory:");
    for (const migration of migrations.filter((m) => m.version < 37)) db.exec(migration.sql);
    db.exec("INSERT INTO runs(id, issue_id, stage_id, attempt, kind, status, config_hash, started_at) VALUES ('run-build', 'i', 'build', 1, 'producer', 'running', 'h', 'x')");
    db.exec("INSERT INTO item_todos(issue_id, items_json, run_id, updated_at) VALUES ('i', '[]', 'run-build', 'x'), ('j', '[]', NULL, 'x')");
    db.exec(migrations.find((m) => m.version === 37)!.sql);
    const todos = new ItemTodos(db);
    expect(todos.get("i")!.stageId).toBe("build");
    expect(todos.get("j")!.stageId).toBeNull();
  });
});
