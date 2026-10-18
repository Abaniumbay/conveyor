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
    web: {}, sources: { github: { type: "github" } },
    labels: { enrollment: "conveyor", stageTemplate: "conveyor:{stage}", states: {}, metadata: { noSplit: "conveyor:no-split" } },
    pipelines: {}, agents: {},
    repositories: {
      repo: { source: "github", address: "owner/my-app", folder: root, baseBranch: "main", pipeline: "delivery", concurrency: 1 },
    },
  } as unknown as ConveyorConfig;
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: root, configHash: "h" });
  const sourceCalls: string[] = [];
  const github = {
    async getIssue() { sourceCalls.push("get"); throw new Error("paused calls must not read the source"); },
    async replaceConveyorLabels() { sourceCalls.push("labels"); },
  };
  const conveyor = new ConveyorService(config, store, github as never);
  const alice = store.createDashboardUser("alice", "hash-a");
  const bob = store.createDashboardUser("bob", "hash-b");
  const actor = (account: { id: string; username: string }, role: CommandActor["role"] = "user"): CommandActor => ({ kind: "user", id: account.id, name: account.username, role });
  return { conveyor, store, alice, bob, actor, sourceCalls };
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

  test("a superuser pauses and resumes a configured repository without admitting source actions", async () => {
    const { conveyor, store, alice, actor, sourceCalls } = await service();
    store.upsertIssue({
      id: "issue", repositoryId: "repo", sourceNumber: 1, sourceUrl: "https://example.com/1", title: "Issue", body: "",
      sourceState: "open", labels: ["conveyor", "conveyor:implementation"], sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
    });
    store.setIssueProjection("issue", { stage: "implementation", state: "active", warning: null });

    await expect(conveyor.commands.dispatch("repository.pause", { repositoryId: "repo", reason: "CI budget" }, actor(alice)))
      .rejects.toBeInstanceOf(CommandForbiddenError);
    await conveyor.commands.dispatch("repository.pause", { repositoryId: "repo", reason: "CI budget" }, actor(alice, "superuser"));
    expect(store.repositoryPause("repo")).toMatchObject({ actor: "alice", reason: "CI budget" });

    await expect(conveyor.pauseIssue("issue", "alice")).rejects.toThrow("Repository is paused");
    expect(() => conveyor.syncRepository("repo")).toThrow("Repository is paused");
    expect(sourceCalls).toEqual([]);
    expect(store.getIssue("issue")).toMatchObject({ projectedStage: "implementation", projectedState: "active" });

    await conveyor.commands.dispatch("repository.resume", { repositoryId: "repo" }, actor(alice, "superuser"));
    expect(store.repositoryPause("repo")).toBeNull();
    await expect(conveyor.commands.dispatch("repository.resume", { repositoryId: "repo" }, actor(alice, "superuser")))
      .rejects.toThrow("repository is not paused");
    await expect(conveyor.commands.dispatch("repository.pause", { repositoryId: "missing", reason: "x" }, actor(alice, "superuser")))
      .rejects.toThrow("repository not found");
    expect(store.repositoryPause("repo")).toBeNull();
    store.close();
  });
});
