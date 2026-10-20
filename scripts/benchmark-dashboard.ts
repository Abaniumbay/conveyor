import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../src/app/service";
import type { ConveyorConfig } from "../src/config/load";
import { ConveyorStore } from "../src/db/store";
import type { DashboardFeedMessage } from "../src/app/dashboard-feed";

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
  const web = service.webDependencies({} as never, "operator");
  // Warm the runtime and SQLite statement caches without including that setup in the result.
  service.dashboard("benchmark");
  const started = performance.now();
  const { model } = web.getDashboardSnapshot!();
  const buildMs = performance.now() - started;
  const bytes = new TextEncoder().encode(JSON.stringify(model)).byteLength;
  const items = Object.values(model.items);
  const done = items.filter((item) => item.placement === "done").length;
  if (model.system.doneTotal !== 350 || items.length !== 110 || done !== 50) {
    throw new Error(`model content changed: expected 350 Done items, 110 in the model and 50 of them finished, got ${model.system.doneTotal}, ${items.length} and ${done}`);
  }

  // A change is built and diffed once, however many dashboards are open: each receives the same patch.
  const dashboards = Array.from({ length: 25 }, () => {
    const messages: DashboardFeedMessage[] = [];
    return { messages, subscription: web.subscribeDashboardFeed!((message) => messages.push(message), null) };
  });
  store.setIssueProjection("benchmark-400", { stage: "implementation", state: "paused", warning: null });
  await service.eventsSettled();
  const changeStarted = performance.now();
  web.getDashboardSnapshot!();
  const changeMs = performance.now() - changeStarted;
  const patches = dashboards.map(({ messages }) => messages.flatMap((message) => message.kind === "patch" ? [message.patch] : []));
  for (const dashboard of dashboards) dashboard.subscription.unsubscribe();
  if (patches[0]!.length === 0 || patches.some((received) => received.length !== patches[0]!.length || received.some((patch, index) => patch !== patches[0]![index]))) {
    throw new Error("a change was not built once and sent to every open dashboard");
  }
  if (bytes >= 200_000 || (assertTiming && (buildMs >= 100 || changeMs >= 100))) {
    throw new Error(`benchmark target missed: ${buildMs.toFixed(1)} ms model build, ${changeMs.toFixed(1)} ms per change, ${bytes} byte snapshot`);
  }
  console.log(JSON.stringify({ items: 410, done: model.system.doneTotal, modelItems: items.length, modelBuildMs: Number(buildMs.toFixed(1)), snapshotBytes: bytes, openDashboards: dashboards.length, patchesPerChange: patches[0]!.length, changeMs: Number(changeMs.toFixed(1)), timingTargetAsserted: assertTiming }));
  await service.close();
  store.close();
} finally {
  await rm(root, { recursive: true, force: true });
}
