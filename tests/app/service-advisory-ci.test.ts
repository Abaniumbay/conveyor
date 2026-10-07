import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CiProvider, CiRun } from "../../src/app/ci-provider";
import { ConveyorService } from "../../src/app/service";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import type { GitHubAdapter } from "../../src/source/github/adapter";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

test("advisory ci.start reports the result under the starting stage without touching stage state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-advisory-svc-"));
  directories.push(root);
  const repositoryPath = path.join(root, "repo");
  await mkdir(repositoryPath);
  await writeFile(path.join(root, "instructions.md"), "Work.");
  await writeFile(path.join(root, "config.yml"), `
settings: { database: ${root}/db.sqlite, logs: ${root}/logs, workspaces: ${root}/workspaces, artifacts: ${root}/artifacts }
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
      - { id: implementation, run: { agent: worker }, concurrency: 1 }
repositories:
  repo: { source: github, address: owner/repo, folder: ${repositoryPath}, pipeline: default }
`);
  const config = await loadConfig(path.join(root, "config.yml"));
  const store = await ConveyorStore.open(config.settings.database);
  store.recordConfigSnapshot(config.hash, config);
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: repositoryPath, configHash: config.hash });
  store.upsertIssue({ id: "issue", repositoryId: "repo", sourceNumber: 1, sourceUrl: "u", title: "F", body: "", sourceState: "open", labels: [], sourceUpdatedAt: "2026-01-01T00:00:00Z" });
  store.setStageState({ issueId: "issue", stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: config.hash });
  const before = JSON.stringify(store.getStageState("issue"));

  const runs: CiRun[] = [{ id: "r1", name: "build", url: "https://ci/build", state: "running", canRerun: false, hasLog: false }];
  const provider = { list: async () => runs } as unknown as CiProvider;
  const service = new ConveyorService(config, store, {} as GitHubAdapter);
  (service as unknown as { ciProvider: () => CiProvider }).ciProvider = () => provider;
  const internals = service as unknown as {
    taskDeps(id: string, repo: { id: string; address: string; folder: string; baseBranch: string }): { ci: { watchAdvisory(input: Record<string, string>): void } };
    pollAdvisoryCi(): Promise<void>;
  };

  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    internals.taskDeps("issue", { id: "repo", address: "owner/repo", folder: repositoryPath, baseBranch: "main" })
      .ci.watchAdvisory({ itemId: "issue", headSha: "abcdef1234", stage: "implementation", changeId: "5", changeUrl: "https://x/pull/5" });
    now += 61_000;
    await internals.pollAdvisoryCi();
    runs[0]!.state = "passed";
    now += 3 * 60_000;
    await internals.pollAdvisoryCi();
    await internals.pollAdvisoryCi();
  } finally {
    clock.mockRestore();
  }
  const messages = store.listConversationMessages("issue");
  expect(messages.map((m) => m.message.split("\n")[0])).toEqual(["CI started for abcdef1: https://x/pull/5/checks", "CI passed at abcdef1: https://x/pull/5/checks"]);
  expect(messages.every((m) => m.stageId === "implementation" && m.actorType === "conveyor")).toBe(true);
  expect(JSON.stringify(store.getStageState("issue"))).toBe(before);
  // Each poll refreshed the stored indicator for the watched head.
  expect(store.listIndicators("issue")).toMatchObject([{ id: "ci", headSha: "abcdef1234", state: "passing", progress: "1/1" }]);
  await service.close();
});
