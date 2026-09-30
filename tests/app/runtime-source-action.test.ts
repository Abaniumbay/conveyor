import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ExternalWaitError } from "../../src/app/ci-gate";
import { ConfiguredStageRuntime, type SourceActionHandler } from "../../src/app/runtime";
import { loadConfig } from "../../src/config/load";
import { PipelineEngine } from "../../src/core/pipeline";
import { ConveyorStore } from "../../src/db/store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(actions: SourceActionHandler, action = "pullRequest.awaitChecks") {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-source-action-"));
  directories.push(root);
  const repository = path.join(root, "repository");
  await mkdir(repository);
  await writeFile(path.join(root, "agent.md"), "Work.");
  await writeFile(path.join(root, "config.yml"), `
settings:
  database: ${root}/db.sqlite
  logs: ${root}/logs
  workspaces: ${root}/workspaces
  artifacts: ${root}/artifacts
web: {}
sources:
  github: { type: github }
runners:
  codex: { type: codex, command: codex }
agents:
  worker:
    runner: codex
    instructions: ./agent.md
    tools: [run.report_progress]
checks: {}
labels:
  enrollment: conveyor
  stageTemplate: "conveyor:{stage}"
  states: { done: "conveyor:done", blocked: "conveyor:blocked" }
  metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" }
pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked, changes-requested]
    stages:
      - id: implementation
        run: { agent: worker }
        concurrency: 1
      - id: ci
        run: { sourceAction: ${action} }
        concurrency: 4
        failurePolicies:
          changes-requested: { action: returnToPrevious }
repositories:
  repo:
    source: github
    address: owner/repo
    folder: ${repository}
    pipeline: default
`);
  const config = await loadConfig(path.join(root, "config.yml"));
  const store = await ConveyorStore.open(config.settings.database);
  store.upsertRepository({
    id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: repository, configHash: config.hash,
  });
  store.upsertIssue({
    id: "issue", repositoryId: "repo", sourceNumber: 1, sourceUrl: "https://github.com/owner/repo/issues/1",
    title: "Feature", body: "", sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  const issue = store.getIssue("issue")!;
  const runtime = new ConfiguredStageRuntime(
    config,
    store,
    {
      issue,
      repository: { id: "repo", address: "owner/repo", folder: repository, baseBranch: "main" },
      workspace: { path: repository, branch: "conveyor/1-r1-feature" },
      sourceGuidance: "",
    },
    { async create() { throw new Error("no agent expected"); } },
    actions,
  );
  return { config, store, issue, runtime };
}

describe("source-action stages", () => {
  test("ci.await and its deprecated alias preserve the same stage outcome", async () => {
    for (const action of ["ci.await", "pullRequest.awaitChecks"]) {
      let invoked = "";
      const { config, issue, runtime } = await setup({
        async run(request) {
          invoked = request.sourceAction;
          return { outcome: "success", status: "done", reason: null, summary: "CI passed." };
        },
      }, action);
      const engine = new PipelineEngine(config.pipelines.default!, runtime, 2);
      const result = await engine.executeStage("ci", { issue: issue as unknown as Record<string, unknown>, workspace: null });
      expect(result).toMatchObject({ kind: "advance", nextStageId: null });
      expect(invoked).toBe(action);
    }
  });

  test("a failing CI outcome returns the issue to the previous stage with the failure as feedback", async () => {
    const { config, store, issue, runtime } = await setup({
      async run() {
        return {
          outcome: "failure",
          status: "changes-requested",
          reason: "CI failed at abc1234: Tests (failure).",
          summary: "CI failed at abc1234: Tests (failure).\n\n### Tests — failure\nlog tail",
        };
      },
    });
    const engine = new PipelineEngine(config.pipelines.default!, runtime, 2);

    const result = await engine.executeStage("ci", { issue: issue as unknown as Record<string, unknown>, workspace: null });

    expect(result).toMatchObject({
      kind: "correction",
      targetStageId: "implementation",
      reason: "CI failed at abc1234: Tests (failure).",
    });
    const messages = store.listConversationMessages(issue.id, 10).map((message) => message.message);
    expect(messages).toEqual(["CI failed at abc1234: Tests (failure).\n\n### Tests — failure\nlog tail"]);
  });

  test("a passing CI outcome advances, and a pending one is rethrown, narrating only its announcement", async () => {
    let pending = true;
    let announce = true;
    const { config, store, issue, runtime } = await setup({
      async run() {
        if (pending) throw new ExternalWaitError("Waiting for CI at abc1234: Tests.", 1_000, announce ? "CI started for abc1234: https://pr/checks" : null);
        return { outcome: "success", status: "done", reason: null, summary: "CI passed at abc1234: Tests (success)." };
      },
    });
    const engine = new PipelineEngine(config.pipelines.default!, runtime, 2);
    const input = { issue: issue as unknown as Record<string, unknown>, workspace: null };

    await expect(engine.executeStage("ci", input)).rejects.toBeInstanceOf(ExternalWaitError);
    announce = false;
    await expect(engine.executeStage("ci", input)).rejects.toBeInstanceOf(ExternalWaitError);
    expect(store.listConversationMessages(issue.id, 10).map((message) => message.message)).toEqual([
      "CI started for abc1234: https://pr/checks",
    ]);

    pending = false;
    await expect(engine.executeStage("ci", input)).resolves.toMatchObject({ kind: "advance", nextStageId: null });
    expect(store.listConversationMessages(issue.id, 10).map((message) => message.message)).toEqual([
      "CI started for abc1234: https://pr/checks",
      "CI passed at abc1234: Tests (success).",
    ]);
  });
});
