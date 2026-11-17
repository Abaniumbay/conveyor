import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { ConsoleSink, log } from "../../src/log/logger";
import { githubPlugins } from "../support/plugins";

const directories: string[] = [];
afterEach(async () => {
  log.configure({ sinks: [new ConsoleSink()] });
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A pipeline whose refinement gate is item.dependenciesMet with `after: review`; later stages pass through on an empty Follow-ups gate. */
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-deps-after-"));
  directories.push(root);
  log.configure({ sinks: [] });
  const repositoryPath = path.join(root, "repo");
  await mkdir(repositoryPath);
  await writeFile(path.join(root, "instructions.md"), "Work.");
  const pass = "actions: [], exit-gate: [{ id: followUps, task: item.followUps }]";
  await writeFile(path.join(root, "config.yml"), `
settings: { database: ${root}/db.sqlite, logs: ${root}/logs, workspaces: ${root}/workspaces, artifacts: ${root}/artifacts }
web: {}
sources: { github: { type: github, webhookSecret: hook-secret } }
runners: { codex: { type: codex } }
agents: { worker: { runner: codex, instructions: ./instructions.md } }
checks: {}
labels:
  enrollment: conveyor
  stageTemplate: "conveyor:{stage}"
  states: { done: "conveyor:done", blocked: "conveyor:blocked" }
  metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" }
pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked]
    stages:
      - { id: refinement, concurrency: 2, actions: [], exit-gate: [{ id: dependencies, task: item.dependenciesMet, with: { after: review } }] }
      - { id: implementation, concurrency: 2, ${pass} }
      - { id: review, concurrency: 2, ${pass} }
      - { id: merge, concurrency: 2, ${pass} }
repositories:
  repo: { source: github, address: owner/repo, folder: ${repositoryPath}, pipeline: default }
`);
  const config = await loadConfig(path.join(root, "config.yml"));
  const store = await ConveyorStore.open(config.settings.database);
  store.recordConfigSnapshot(config.hash, config);
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: repositoryPath, configHash: config.hash });
  const add = (id: string, number: number, stage: string) => {
    store.upsertIssue({ id, repositoryId: "repo", sourceNumber: number, sourceUrl: "u", title: id, body: "", sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z" });
    store.setIssueProjection(id, { stage, state: "active", warning: null });
  };
  add("issue", 1, "refinement");
  store.setStageState({ issueId: "issue", stageId: "refinement", status: "ready", feedbackCycle: 0, configHash: config.hash });
  store.activateEnrollment("issue");
  add("blocker", 7, "review");
  store.replaceRelationships("issue", null, ["blocker"]);
  const github = {
    async listIssues() { return []; },
    async listSubIssues() { return []; },
    async listDependencies() { return []; },
    async collaboratorPermission() { return "write" as const; },
    async upsertStatusComment() { return 1; },
    async replaceConveyorLabels() {},
  };
  const service = new ConveyorService(config, store, github as never, { plugins: githubPlugins(config, github as never) });
  service.drain("tests: nothing executes");
  const internals = service as unknown as {
    execute(issue: NonNullable<ReturnType<ConveyorStore["getIssue"]>>, signal: AbortSignal): Promise<boolean>;
  };
  const execute = () => internals.execute(store.getIssue("issue")!, new AbortController().signal);
  return { service, store, execute };
}

test("AC-8.1 a blocker passing the after stage wakes a parked dependent at once and the rerun advances it", async () => {
  const w = await setup();
  await w.execute();
  const journal = w.store.executions();
  expect(journal.getCursor("issue")).toMatchObject({ taskInstanceId: "dependencies", state: "pending" });
  const parkedUntil = Date.parse(journal.getCursor("issue")!.wakeAt!);
  expect(parkedUntil - Date.now()).toBeGreaterThan(60_000);

  w.store.setIssueProjection("blocker", { stage: "merge", state: "active", warning: null });
  await w.service.eventsSettled();
  expect(Date.parse(journal.getCursor("issue")!.wakeAt!)).toBeLessThanOrEqual(Date.now());

  await w.execute();
  expect(journal.getCursor("issue")).toBeNull();
  expect(w.store.getStageState("issue")?.stageId).toBe("implementation");
  await w.service.close();
});

test("AC-8.1 a blocker staying at or before the after stage does not release the parked dependent", async () => {
  const w = await setup();
  await w.execute();
  w.store.setIssueProjection("blocker", { stage: "review", state: "active", warning: null });
  await w.service.eventsSettled();
  await w.execute();
  expect(w.store.executions().getCursor("issue")).toMatchObject({ taskInstanceId: "dependencies", state: "pending" });
  expect(w.store.getStageState("issue")?.stageId).toBe("refinement");
  await w.service.close();
});

test("AC-6.2 a dependent that passed the check keeps its stage and is not re-checked when its blocker is sent back", async () => {
  const w = await setup();
  w.store.setIssueProjection("blocker", { stage: "merge", state: "active", warning: null });
  await w.execute();
  expect(w.store.getStageState("issue")?.stageId).toBe("implementation");

  // The source confirms the move, as its sync would, and then the blocker is sent back.
  w.store.setIssueProjection("issue", { stage: "implementation", state: "active", warning: null });
  w.store.setStageState({ issueId: "issue", stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: w.store.getStageState("issue")!.configHash });
  w.store.setIssueProjection("blocker", { stage: "implementation", state: "active", warning: null });
  await w.service.eventsSettled();
  expect(w.store.getStageState("issue")).toMatchObject({ stageId: "implementation", status: "ready" });
  expect(w.store.getIssue("issue")).toMatchObject({ projectedStage: "implementation", projectedState: "active" });

  await w.execute();
  // The dependenciesMet step does not run in a later stage: the dependent moves on, never back to refinement or into a wait.
  expect(w.store.executions().getCursor("issue")).toBeNull();
  expect(w.store.listStageTransitions("issue").map((t) => `${t.kind} ${t.fromStage}>${t.toStage}`)).toEqual([
    "advance refinement>implementation", "advance implementation>review",
  ]);
  await w.service.close();
});
