import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../src/app/service";
import type { ConveyorConfig } from "../src/config/load";
import { ConveyorStore } from "../src/db/store";
import { renderDashboard } from "../src/web/render";

const root = await mkdtemp(path.join(tmpdir(), "conveyor-dashboard-benchmark-"));
const assertTiming = process.env.CONVEYOR_BENCHMARK_ASSERT_TIMING === "1";
try {
  const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
  const config = {
    hash: "benchmark-config",
    root,
    settings: { artifacts: path.join(root, "artifacts"), workspaces: path.join(root, "workspaces"), runners: 1, labelPrefix: "conveyor" },
    web: { listen: "127.0.0.1:4300" },
    sources: { github: { type: "github" } },
    labels: { enrollment: "conveyor", stageTemplate: "conveyor:{stage}", states: { done: "conveyor:done" }, metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" } },
    pipelines: { default: { successStatuses: ["done"], failureStatuses: ["blocked"], stages: [{ id: "implementation", run: { type: "agent", agent: "implementer" }, concurrency: 1, failurePolicies: {}, afterSuccess: [] }] } },
    repositories: { benchmark: { source: "github", address: "owner/benchmark", folder: root, baseBranch: "main", pipeline: "default", concurrency: 1, systemLabels: [] } },
    agents: {},
  } as unknown as ConveyorConfig;
  store.upsertRepository({ id: "benchmark", configName: "benchmark", source: "github", address: "owner/benchmark", folder: root, configHash: config.hash });

  for (let number = 1; number <= 410; number += 1) {
    const done = number <= 350;
    const id = `benchmark-${number}`;
    store.upsertIssue({
      id, repositoryId: "benchmark", sourceNumber: number,
      sourceUrl: `https://github.com/owner/benchmark/issues/${number}`,
      title: `Benchmark item ${number}`, body: "", sourceState: done ? "closed" : "open",
      sourceStateReason: done ? "completed" : null,
      labels: done ? ["conveyor", "conveyor:done"] : ["conveyor", "conveyor:implementation"],
      sourceUpdatedAt: `2026-01-${String((number % 28) + 1).padStart(2, "0")}T00:00:00Z`,
    });
    store.setQueueRank(id, number);
    store.setIssueProjection(id, { stage: done ? "implementation" : "implementation", state: done ? "done" : "active", warning: null });
    if (!done) store.setStageState({ issueId: id, stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: config.hash });
  }

  const service = new ConveyorService(config, store, {} as never);
  // Warm the runtime and SQLite statement caches without including that setup in the result.
  service.dashboard("benchmark");
  const started = performance.now();
  const model = service.dashboard("benchmark");
  const buildMs = performance.now() - started;
  const html = renderDashboard(model);
  const bytes = new TextEncoder().encode(html).byteLength;
  const visible = model.stages.reduce((total, stage) => total + stage.issues.length, 0) + model.backlog.length + model.done.issues.length;
  if (model.done.totalIssues !== 350 || visible !== 80) {
    throw new Error(`board content changed: expected 350 Done items and 80 visible cards, got ${model.done.totalIssues} and ${visible}`);
  }
  if (bytes >= 200_000 || (assertTiming && buildMs >= 100)) {
    throw new Error(`benchmark target missed: ${buildMs.toFixed(1)} ms model build, ${bytes} byte page`);
  }
  console.log(JSON.stringify({ items: 410, done: model.done.totalIssues, visibleCards: visible, modelBuildMs: Number(buildMs.toFixed(1)), pageBytes: bytes, timingTargetAsserted: assertTiming }));
  store.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
