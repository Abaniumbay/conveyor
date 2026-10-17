import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import { CommandForbiddenError, type CommandActor } from "../../src/commands/bus";
import { COMMANDS, type CommandName } from "../../src/commands/registry";
import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { ConsoleSink, log } from "../../src/log/logger";

const directories: string[] = [];
afterEach(async () => {
  log.configure({ sinks: [new ConsoleSink()] });
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function service() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-service-commands-"));
  directories.push(root);
  log.configure({ sinks: [] });
  const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
  const config = {
    hash: "h", root,
    settings: { artifacts: path.join(root, "artifacts"), workspaces: path.join(root, "worktrees"), runners: 1, labelPrefix: "conveyor", retention: { runHistoryMs: null, artifactsMs: null } },
    web: {}, sources: { github: { type: "github" } }, labels: {}, pipelines: {}, agents: {}, repositories: {},
  } as unknown as ConveyorConfig;
  const conveyor = new ConveyorService(config, store, {} as never);
  const alice = store.createDashboardUser("alice", "hash-a");
  const bob = store.createDashboardUser("bob", "hash-b");
  const actor = (account: { id: string; username: string }, role: CommandActor["role"] = "user"): CommandActor => ({ kind: "user", id: account.id, name: account.username, role });
  return { conveyor, store, alice, bob, actor };
}

describe("account commands", () => {
  test("an account changes its own avatar", async () => {
    const { conveyor, store, alice, actor } = await service();
    await conveyor.commands.dispatch("account.setAvatar", { accountId: alice.id, avatar: "owl" }, actor(alice));
    expect(store.dashboardAccountById(alice.id)?.avatar).toBe("owl");
    store.close();
  });

  test("an ordinary account cannot change another account's password", async () => {
    const { conveyor, store, alice, bob, actor } = await service();
    await expect(conveyor.commands.dispatch("account.setPassword", { accountId: bob.id, passwordHash: "x" }, actor(alice))).rejects.toBeInstanceOf(CommandForbiddenError);
    expect(store.dashboardAccountById(bob.id)?.passwordHash).toBe("hash-b");
    store.close();
  });

  test("a superuser resets another account's password", async () => {
    const { conveyor, store, alice, bob, actor } = await service();
    await conveyor.commands.dispatch("account.setPassword", { accountId: bob.id, passwordHash: "reset" }, actor(alice, "superuser"));
    expect(store.dashboardAccountById(bob.id)?.passwordHash).toBe("reset");
    store.close();
  });

  test("an ordinary account cannot change another account's notifications", async () => {
    const { conveyor, store, alice, bob, actor } = await service();
    await expect(conveyor.commands.dispatch("notifications.updateSettings", { accountId: bob.id, preferences: { questions: true, stopped: true, done: true } }, actor(alice)))
      .rejects.toBeInstanceOf(CommandForbiddenError);
    store.close();
  });
});

describe("service commands", () => {
  test("every command except the control socket's own has a handler", async () => {
    const { conveyor, store } = await service();
    const missing = (Object.keys(COMMANDS) as CommandName[]).filter((name) => !conveyor.commands.has(name));
    expect(missing).toEqual(["service.restart", "release.schedule", "release.cancel"]);
    store.close();
  });
});
