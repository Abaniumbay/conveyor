import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { CriterionApprovals, criterionTextHash } from "../../src/engine/review-records";
import type { TaskContext } from "../../src/tasks/context";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const BODY = `<!-- conveyor:acceptance-criteria:start -->
- [ ] Current criterion <!-- conveyor:criterion:AC-1 -->
- [ ] Other criterion <!-- conveyor:criterion:AC-2 -->
<!-- conveyor:acceptance-criteria:end -->`;

async function setup(merged = false) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-service-criteria-"));
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
      - id: implementation
        concurrency: 1
        actions: []
        exit-gate:
          - { id: ciGate, task: ci.passed, with: { settleSeconds: 120 } }
repositories:
  repo: { source: github, address: owner/repo, folder: ${repositoryPath}, pipeline: default }
`);
  const config = await loadConfig(path.join(root, "config.yml"));
  const store = await ConveyorStore.open(config.settings.database);
  store.recordConfigSnapshot(config.hash, config);
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: repositoryPath, configHash: config.hash });
  store.upsertIssue({
    id: "issue", repositoryId: "repo", sourceNumber: 1, sourceUrl: "https://example.test/1", title: "Feature", body: BODY,
    sourceState: merged ? "closed" : "open", labels: ["conveyor", "conveyor:implementation"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  store.setIssueProjection("issue", { stage: "implementation", state: merged ? "done" : "active", warning: null });
  store.setStageState({ issueId: "issue", stageId: "implementation", status: merged ? "done" : "ready", feedbackCycle: 0, configHash: config.hash });
  store.activateEnrollment("issue");
  if (merged) store.upsertPullRequest({ issueId: "issue", id: "pr-1", number: 1, url: "https://example.test/pr/1", state: "merged", mergedAt: "2026-01-01T00:01:00Z" });
  else store.upsertPullRequest({ issueId: "issue", id: "pr-1", number: 1, url: "https://example.test/pr/1", state: "open" });

  const statusComments: string[] = [];
  const github = { async upsertStatusComment(_address: string, _number: number, markdown: string) { statusComments.push(markdown); return statusComments.length; } };
  const service = new ConveyorService(config, store, github as never);
  service.drain("tests: nothing executes");
  const internals = service as unknown as { updateStatusComment(id: string): Promise<void> };
  const persist = (state: "open" | "merged", headSha: string, reviewPassed: string | null) => {
    const context: TaskContext = {
      schemaVersion: 1, configHash: config.hash,
      run: { stage: "implementation", stageEpoch: 0, attempt: 1, maxAttempts: 1, taskInstanceId: "review", enteredAt: "2026-01-01T00:00:00Z", feedback: null },
      repository: { id: "repo", address: "owner/repo", folder: repositoryPath, baseBranch: "main", ciMode: "required", systemLabels: [] },
      item: { id: "issue", number: 1, title: "Feature", url: "https://example.test/1", labels: ["conveyor", "conveyor:implementation"], state: merged ? "closed" : "open", criteria: [], children: [], dependencies: [], systemLabels: [] },
      change: { ref: { provider: "github", id: "pr-1", number: 1 }, url: "https://example.test/pr/1", state, draft: false, headSha, baseBranch: "main", mergeable: "yes", mergeCommitSha: state === "merged" ? "merge" : null, criteria: [], projectedCriterionIds: [], projectionError: null, findings: [] },
      checkpoints: { ciPassed: null, reviewPassed: reviewPassed ? { sha: reviewPassed, at: "2026-01-01T00:00:00Z", taskInstanceId: "review" } : null },
    };
    store.executions().saveContext("issue", context, { stage: "implementation", taskInstanceId: "review", expectedEpoch: store.executions().stageEpoch("issue") });
  };
  const card = () => service.dashboard("csrf", { view: "board", column: null, page: 1, doneLimit: 20, runId: null, issueId: "issue" }).selectedIssue!;
  return { config, store, service, internals, statusComments, persist, card };
}

test("projects current-head approvals into status comments and dashboard details", async () => {
  const w = await setup();
  w.persist("open", "head-1", null);
  const approvals = new CriterionApprovals(w.store.sqlite());
  approvals.approve({ issueId: "issue", criterionId: "AC-1", reviewer: "reviewer", headSha: "head-1", checkedAt: "t", textHash: criterionTextHash("Current criterion") });
  approvals.approve({ issueId: "issue", criterionId: "AC-2", reviewer: "reviewer", headSha: "stale", checkedAt: "t", textHash: criterionTextHash("Other criterion") });

  await w.internals.updateStatusComment("issue");
  expect(w.statusComments.at(-1)).toContain("- [x] Current criterion");
  expect(w.statusComments.at(-1)).toContain("- [ ] Other criterion");
  expect(w.card().acceptanceCriteria).toEqual([
    { id: "AC-1", text: "Current criterion", approved: true },
    { id: "AC-2", text: "Other criterion", approved: false },
  ]);

  w.persist("open", "head-2", null);
  await w.internals.updateStatusComment("issue");
  expect(w.statusComments.at(-1)).toContain("- [ ] Current criterion");
  approvals.approve({ issueId: "issue", criterionId: "AC-1", reviewer: "reviewer", headSha: "head-2", checkedAt: "t", textHash: criterionTextHash("Edited criterion") });
  await w.internals.updateStatusComment("issue");
  expect(w.statusComments.at(-1)).toContain("- [ ] Current criterion");
  approvals.withdraw("issue", "AC-1");
  await w.internals.updateStatusComment("issue");
  expect(w.statusComments.at(-1)).toContain("- [ ] Current criterion");
  await w.service.close();
});

test("keeps merged-head approvals after reopening persisted state and leaves no-change items unchecked", async () => {
  const w = await setup(true);
  w.persist("merged", "merged-head", "review-head");
  new CriterionApprovals(w.store.sqlite()).approve({ issueId: "issue", criterionId: "AC-1", reviewer: "reviewer", headSha: "merged-head", checkedAt: "t", textHash: criterionTextHash("Current criterion") });
  await w.service.close();

  const reopenedStore = await ConveyorStore.open(w.config.settings.database);
  const comments: string[] = [];
  const reopened = new ConveyorService(w.config, reopenedStore, { async upsertStatusComment(_address: string, _number: number, markdown: string) { comments.push(markdown); return comments.length; } } as never);
  reopened.drain("tests: nothing executes");
  await (reopened as unknown as { updateStatusComment(id: string): Promise<void> }).updateStatusComment("issue");
  expect(comments.at(-1)).toContain("- [x] Current criterion");
  expect(reopened.dashboard("csrf", { view: "board", column: null, page: 1, doneLimit: 20, runId: null, issueId: "issue" }).selectedIssue?.acceptanceCriteria[0]).toMatchObject({ approved: true });
  expect(reopenedStore.getIssue("issue")?.body).toBe(BODY);
  await reopened.close();

  const reviewPassed = await setup(true);
  reviewPassed.persist("open", "later-head", "review-head");
  new CriterionApprovals(reviewPassed.store.sqlite()).approve({ issueId: "issue", criterionId: "AC-1", reviewer: "reviewer", headSha: "review-head", checkedAt: "t", textHash: criterionTextHash("Current criterion") });
  await reviewPassed.internals.updateStatusComment("issue");
  expect(reviewPassed.statusComments.at(-1)).toContain("- [x] Current criterion");
  await reviewPassed.service.close();

  const noChange = await setup();
  noChange.store.sqlite().query("DELETE FROM pull_requests").run();
  noChange.persist("open", "head-1", null);
  await noChange.internals.updateStatusComment("issue");
  expect(noChange.statusComments.at(-1)).toContain("- [ ] Current criterion");
  expect(noChange.card().acceptanceCriteria.every((criterion) => !criterion.approved)).toBe(true);
  await noChange.service.close();
});
