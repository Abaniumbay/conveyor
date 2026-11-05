import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { renderDashboard } from "../support/render-dashboard";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const REASON = "Change #23 merged, but GitHub did not close issue #1. Conveyor never closes the issue itself: close the issue as completed, or reopen the work.";

async function stoppedItem() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-left-open-"));
  directories.push(root);
  const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
  const config = {
    hash: "h", root,
    settings: { artifacts: path.join(root, "artifacts"), workspaces: path.join(root, "workspaces"), runners: 1, labelPrefix: "conveyor" },
    labels: {
      enrollment: "conveyor", stageTemplate: "conveyor:{stage}",
      states: { done: "conveyor:done", "needs-intervention": "conveyor:needs-intervention" },
      metadata: { closable: "conveyor:closable", noSplit: "conveyor:no-split", orderTemplate: "conveyor:order:{number}" },
    },
    pipelines: { default: { stages: [{ id: "cleanup", actions: [], exitGate: [{ id: "issueClosed", task: "item.issueClosed" }], concurrency: 1 }] } },
    repositories: { repo: { source: "github", address: "owner/my-app", folder: root, baseBranch: "main", pipeline: "default", concurrency: 1, systemLabels: [] } },
    agents: {},
  } as unknown as ConveyorConfig;
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: root, configHash: "h" });
  store.upsertIssue({
    id: "item", repositoryId: "repo", sourceNumber: 1, sourceUrl: "https://example.com/1", title: "Shipped but open", body: "",
    sourceState: "open", labels: ["conveyor", "conveyor:cleanup", "conveyor:needs-intervention"], sourceUpdatedAt: "2026-11-04T10:00:00Z",
  });
  store.activateEnrollment("item");
  store.setIssueProjection("item", { stage: "cleanup", state: "needs-intervention", warning: null });
  store.beginStageTransition({ id: "stopped", issueId: "item", fromStage: "cleanup", toStage: "cleanup", kind: "stopped", sourceMutationId: null, detail: { reason: REASON, requiredFixes: [], resultStatus: null } });
  store.completeStageTransition("stopped");
  const service = new ConveyorService(config, store, {} as never);
  return { service, store };
}

test("the Needs you list and the dashboard card show the reason", async () => {
  const { service, store } = await stoppedItem();
  const model = service.dashboard("csrf");
  expect(model.needsYou.map((card) => [card.number, card.reason])).toEqual([[1, REASON]]);
  const html = renderDashboard(model);
  const start = html.indexOf('<section class="needs-you"');
  expect(start).toBeGreaterThan(-1);
  const needsYou = html.slice(start, html.indexOf("</section>", start));
  expect(needsYou).toContain("Shipped but open");
  expect(needsYou).toContain("GitHub did not close issue #1");
  expect(needsYou).toContain("close the issue as completed, or reopen the work");
  store.close();
});
