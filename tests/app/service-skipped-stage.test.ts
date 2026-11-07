import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore, type StoredIssue } from "../../src/db/store";
import type { GitHubAdapter } from "../../src/source/github/adapter";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("a skipped stage neither waits for nor consumes the stage's concurrency in the real scheduling path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-service-skipped-"));
  directories.push(root);
  for (const name of ["skipper", "runner"]) await mkdir(path.join(root, name));
  await writeFile(path.join(root, "instructions.md"), "Work.");
  await writeFile(path.join(root, "config.yml"), `
settings:
  database: ${root}/db.sqlite
  logs: ${root}/logs
  workspaces: ${root}/workspaces
  artifacts: ${root}/artifacts
  runners: 10
web: {}
sources: { github: { type: github } }
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
      - { id: refinement, run: { agent: worker }, concurrency: 1 }
      - { id: implementation, run: { agent: worker }, concurrency: 5 }
repositories:
  skipper:
    source: github
    address: owner/skipper
    folder: ${root}/skipper
    pipeline: default
    concurrency: 5
    overrides: { stages: { refinement: { skip: true } } }
  runner:
    source: github
    address: owner/runner
    folder: ${root}/runner
    pipeline: default
    concurrency: 5
`);
  const config = await loadConfig(path.join(root, "config.yml"));
  const store = await ConveyorStore.open(config.settings.database);
  for (const name of ["skipper", "runner"]) {
    store.upsertRepository({ id: name, configName: name, source: "github", address: `owner/${name}`, folder: path.join(root, name), configHash: config.hash });
  }
  const service = new ConveyorService(config, store, { async upsertStatusComment() { return 1; } } as unknown as GitHubAdapter);
  const started: string[] = [];
  const release: Array<() => void> = [];
  // Every started item holds its worker until released, so occupancy is real.
  (service as unknown as { execute(issue: StoredIssue): Promise<void> }).execute = (issue) => {
    started.push(issue.id);
    return new Promise<void>((resolve) => release.push(resolve));
  };
  const enroll = (repository: string, number: number) => {
    const id = `${repository}-${number}`;
    store.upsertIssue({
      id, repositoryId: repository, sourceNumber: number, sourceUrl: `https://example.test/${number}`, title: id, body: "",
      sourceState: "open", labels: ["conveyor", "conveyor:refinement"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    store.setIssueProjection(id, { stage: "refinement", state: "active", warning: null });
    store.setQueueRank(id, store.nextQueueRank());
    store.setStageState({ issueId: id, stageId: "refinement", status: "ready", feedbackCycle: 0, configHash: config.hash });
  };
  const schedule = () => (service as unknown as { schedule(): void }).schedule();

  // Both skipping items start although the stage's capacity is 1: they do not wait for it.
  enroll("skipper", 1);
  enroll("skipper", 2);
  schedule();
  expect([...started].sort()).toEqual(["skipper-1", "skipper-2"]);

  // They still run, yet do not occupy the stage: one item that really runs it is admitted, the next waits.
  enroll("runner", 3);
  enroll("runner", 4);
  schedule();
  expect([...started].sort()).toEqual(["runner-3", "skipper-1", "skipper-2"]);
  release.forEach((resolve) => resolve());
  await service.close();
});
