import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

import { CommandBus } from "../../src/commands/bus";
import type { CommandName } from "../../src/commands/registry";
import { migrations } from "../../src/db/migrations";
import { eventLog } from "../../src/events/log";
import { OPERATOR_TOOLS } from "../../src/operator-mcp/registry";
import type { OperatorFacade } from "../../src/operator-mcp/tool";

const ITEMS: Record<string, { issueId: string; running: boolean }> = {
  "app:1": { issueId: "issue-1", running: false },
  "app:2": { issueId: "issue-2", running: true },
};

function setup() {
  const database = new Database(":memory:");
  for (const migration of migrations) database.exec(migration.sql);
  const commands = new CommandBus(eventLog(database));
  const received: Array<[string, unknown]> = [];
  commands.handle("item.retry", (input) => { received.push(["item.retry", input]); return { status: "queued" as const, stageId: "implementation" }; });
  commands.handle("item.postMessage", (input) => { received.push(["item.postMessage", input]); return { status: "delivered" }; });
  commands.handle("item.pause", (input) => { received.push(["item.pause", input]); return { stageId: "implementation" }; });
  commands.handle("item.resume", (input) => { received.push(["item.resume", input]); return { status: "started" as const, stageId: "implementation" }; });
  commands.handle("question.answer", (input) => { received.push(["question.answer", input]); });
  const facade: OperatorFacade = {
    store: {} as OperatorFacade["store"],
    status: () => ({}),
    createIssue: () => { throw new Error("unused"); },
    findItem: (reference) => ITEMS[reference] ?? null,
    dispatch: (name: CommandName, input) => commands.dispatch(name, input as never, { kind: "cli", id: null, name: "operator MCP client", role: "superuser" }) as never,
  };
  const call = (name: string, input: unknown) => OPERATOR_TOOLS.find((tool) => tool.name === name)!.handler({ input, facade });
  return { received, call };
}

describe("operator control tools", () => {
  test("item_retry retries the item through the command bus", async () => {
    const { received, call } = setup();
    expect(await call("item_retry", { item: "app:1", note: "try again" })).toEqual({ status: "queued", stageId: "implementation" });
    expect(received).toEqual([["item.retry", { issueId: "issue-1", note: "try again" }]]);
  });

  test("item_steer posts the message for an item with a running agent", async () => {
    const { received, call } = setup();
    await call("item_steer", { item: "app:2", message: "use the other approach" });
    expect(received).toEqual([["item.postMessage", { issueId: "issue-2", message: "use the other approach" }]]);
  });

  test("item_pause pauses and item_resume resumes", async () => {
    const { received, call } = setup();
    await call("item_pause", { item: "app:1" });
    await call("item_resume", { item: "app:1" });
    expect(received).toEqual([["item.pause", { issueId: "issue-1" }], ["item.resume", { issueId: "issue-1" }]]);
  });

  test("question_answer answers the question through the bus", async () => {
    const { received, call } = setup();
    await call("question_answer", { questionId: "q-1", answer: "yes" });
    expect(received).toEqual([["question.answer", { questionId: "q-1", answer: "yes" }]]);
  });

  test("retrying or steering an unknown item is a tool error naming it, and sends nothing", async () => {
    const { received, call } = setup();
    await expect(call("item_retry", { item: "app:99" })).rejects.toThrow("Unknown item: app:99");
    await expect(call("item_steer", { item: "app:98", message: "hi" })).rejects.toThrow("Unknown item: app:98");
    expect(received).toEqual([]);
  });

  test("steering an item with no running agent is a tool error and sends nothing", async () => {
    const { received, call } = setup();
    await expect(call("item_steer", { item: "app:1", message: "hi" })).rejects.toThrow("No agent is running on app:1");
    expect(received).toEqual([]);
  });
});

describe("no REST or control API route for operator control", () => {
  const sources = ["src/control/server.ts", "src/web/server.ts"].map((file) => readFileSync(file, "utf8"));

  test("neither server mentions the operator tools, and the tools live only in the MCP module", () => {
    for (const tool of ["item_retry", "item_steer", "item_pause", "item_resume", "question_answer"]) {
      for (const source of sources) expect(source).not.toContain(tool);
    }
    for (const source of sources) expect(source).not.toContain("operator-mcp/tools/control");
  });
});
