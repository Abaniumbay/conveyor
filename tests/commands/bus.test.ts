import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { CommandBus, CommandForbiddenError, CommandInputError, CommandUnavailableError, type CommandActor } from "../../src/commands/bus";
import { COMMANDS } from "../../src/commands/registry";
import { migrations } from "../../src/db/migrations";
import { eventLog } from "../../src/events/log";
import { currentGitHubCallSource } from "../../src/source/github/call-meter";

const superuser: CommandActor = { kind: "user", id: "admin-1", name: "admin", role: "superuser" };
const user: CommandActor = { kind: "user", id: "user-1", name: "someone", role: "user" };

function bus() {
  const database = new Database(":memory:");
  for (const migration of migrations) database.exec(migration.sql);
  const events = eventLog(database);
  return { commands: new CommandBus(events), events };
}

describe("CommandBus", () => {
  test("runs the handler with the validated input and the actor, and returns its result", async () => {
    const { commands } = bus();
    const seen: unknown[] = [];
    commands.handle("backlog.reorder", (input, actor) => { seen.push([input, actor.name]); });
    const outcome = await commands.dispatch("backlog.reorder", { issueId: "i-1", direction: "up" }, superuser);
    expect(seen).toEqual([[{ issueId: "i-1", direction: "up" }, "admin"]]);
    expect(outcome).toEqual({ correlationId: expect.any(String), result: undefined });
  });

  test("scopes an item's command correlation and actor to events for that item", async () => {
    const { commands, events } = bus();
    commands.handle("backlog.reorder", () => {
      events.append("item.offboarded", { status: "test" }, { issueId: "i-1" });
      events.append("item.offboarded", { status: "test" }, { issueId: "i-2" });
    });
    const { correlationId } = await commands.dispatch("backlog.reorder", { issueId: "i-1", direction: "up" }, superuser);
    const [forCommand, forAnotherItem, accepted] = events.read();
    expect(forCommand?.issueId).toBe("i-1");
    expect(forCommand?.correlationId).toBe(correlationId);
    expect(forCommand?.actor).toEqual({ kind: "user", id: "admin-1" });
    expect(forAnotherItem?.issueId).toBe("i-2");
    expect(forAnotherItem?.correlationId).toBeNull();
    expect(forAnotherItem?.actor).toEqual({ kind: "system", id: null });
    expect(accepted?.type).toBe("command.accepted");
    expect(accepted?.correlationId).toBe(correlationId);
  });

  test("keeps an unscoped command's correlation on every handler event", async () => {
    const { commands, events } = bus();
    commands.handle("admission.resume", () => {
      events.append("item.offboarded", { status: "test" }, { issueId: "i-1" });
      return true;
    });
    const { correlationId } = await commands.dispatch("admission.resume", {}, superuser);
    expect(events.read({ correlationId }).map((event) => [event.type, event.actor])).toEqual([
      ["item.offboarded", { kind: "user", id: "admin-1" }],
      ["command.accepted", { kind: "user", id: "admin-1" }],
    ]);
  });

  test("an invalid input is refused before the handler runs and is recorded", async () => {
    const { commands, events } = bus();
    let ran = false;
    commands.handle("backlog.reorder", () => { ran = true; });
    // @ts-expect-error the direction is deliberately invalid
    await expect(commands.dispatch("backlog.reorder", { issueId: "i-1", direction: "sideways" }, superuser)).rejects.toBeInstanceOf(CommandInputError);
    expect(ran).toBe(false);
    expect(events.read({ type: "command.rejected" }).map((event) => event.payload)).toEqual([{ command: "backlog.reorder", reason: expect.stringContaining("direction") }]);
  });

  test("a superuser command from an ordinary account is forbidden", async () => {
    const { commands } = bus();
    commands.handle("item.retry", () => ({ status: "queued" as const, stageId: "s" }));
    await expect(commands.dispatch("item.retry", { issueId: "i-1", note: "" }, user)).rejects.toBeInstanceOf(CommandForbiddenError);
  });

  test("a command without a handler in this process is unavailable", async () => {
    const { commands } = bus();
    await expect(commands.dispatch("release.cancel", {}, superuser)).rejects.toBeInstanceOf(CommandUnavailableError);
  });

  test("a handler's own error is rethrown unchanged and recorded with its reason", async () => {
    const { commands, events } = bus();
    const failure = new Error("issue not found");
    commands.handle("item.pause", () => { throw failure; });
    await expect(commands.dispatch("item.pause", { issueId: "i-1" }, superuser)).rejects.toBe(failure);
    expect(events.read({ type: "command.rejected" }).map((event) => event.payload)).toEqual([{ command: "item.pause", reason: "issue not found" }]);
  });

  test("GitHub requests a handler makes count as the command's", async () => {
    const { commands } = bus();
    let source = "";
    commands.handle("admission.resume", async () => {
      await Bun.sleep(1);
      source = currentGitHubCallSource();
      return true;
    });
    await commands.dispatch("admission.resume", {}, superuser);
    expect(source).toBe("command");
  });

  test("a command has exactly one handler", () => {
    const { commands } = bus();
    commands.handle("admission.resume", () => true);
    expect(() => commands.handle("admission.resume", () => true)).toThrow("already has a handler");
  });

  test("every command declares a role, a description and an input schema", () => {
    for (const [name, definition] of Object.entries(COMMANDS)) {
      expect(["user", "superuser"]).toContain(definition.role);
      expect(definition.description.length).toBeGreaterThan(10);
      expect(typeof definition.input.safeParse).toBe("function");
      expect(name).toMatch(/^[a-z]+\.[a-zA-Z]+$/);
    }
  });
});
