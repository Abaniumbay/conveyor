import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore, STOP_SUMMARY_MAX_LENGTH } from "../../src/db/store";
import { renderDashboard } from "../support/render-dashboard";
import { dashboardViews } from "../support/dashboard";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const LONG_FIRST_LINE = `Required check failed: ${"x".repeat(400)}`;
const REASON = `${LONG_FIRST_LINE}\nsecond line of the log\n\nFirst failure: https://example.com/pull/1`;

async function world() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-stop-summary-dashboard-"));
  directories.push(root);
  const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
  const config = {
    hash: "h", root,
    settings: { artifacts: path.join(root, "artifacts"), workspaces: path.join(root, "workspaces"), runners: 1, labelPrefix: "conveyor" },
    labels: {
      enrollment: "conveyor", stageTemplate: "conveyor:{stage}",
      states: { done: "conveyor:done", "needs-intervention": "conveyor:needs-intervention" },
      metadata: { closable: "conveyor:closable", noSplit: "conveyor:no-split", paused: "conveyor:paused", orderTemplate: "conveyor:order:{number}" },
    },
    pipelines: { default: { stages: [{ id: "implementation", actions: [], exitGate: [], concurrency: 1 }] } },
    repositories: { repo: { source: "github", address: "owner/my-app", folder: root, baseBranch: "main", pipeline: "default", concurrency: 1, systemLabels: [] } },
    agents: {},
  } as unknown as ConveyorConfig;
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: root, configHash: "h" });
  store.upsertIssue({
    id: "item", repositoryId: "repo", sourceNumber: 1, sourceUrl: "https://example.com/1", title: "Stopped item", body: "",
    sourceState: "open", labels: ["conveyor", "conveyor:implementation", "conveyor:needs-intervention"], sourceUpdatedAt: "2026-11-04T10:00:00Z",
  });
  store.activateEnrollment("item");
  store.setIssueProjection("item", { stage: "implementation", state: "needs-intervention", warning: null });
  let sequence = 0;
  const transition = (kind: string, reason: string | null) => {
    const id = `t${String(++sequence).padStart(4, "0")}`;
    store.beginStageTransition({ id, issueId: "item", fromStage: "implementation", toStage: "implementation", kind, sourceMutationId: null, detail: { reason, requiredFixes: [], resultStatus: null } });
    store.completeStageTransition(id);
    return id;
  };
  const service = new ConveyorService(config, store, {} as never);
  return { service, store, transition };
}

describe("stop summary on the dashboard model", () => {
  test("a recorded summary is the Needs you text; the full reason stays the item's reason", async () => {
    const { service, store, transition } = await world();
    const stopId = transition("stopped", REASON);
    store.recordStopSummary({ issueId: "item", stopId, summary: "Fix the failing check." });
    const model = dashboardViews(service).dashboard("csrf");
    const card = model.needsYou[0]!;
    expect(card.stopSummary).toBe("Fix the failing check.");
    expect(card.reason).toBe(REASON);
    const html = renderDashboard(model);
    const start = html.indexOf('<section class="needs-you"');
    const needsYou = html.slice(start, html.indexOf("</section>", start));
    expect(needsYou).toContain("<p>Fix the failing check.</p>");
    expect(needsYou).not.toContain("Required check failed");
    store.close();
  });

  test("without a summary the headline is the first line of the reason cut to the summary limit", async () => {
    const { service, store, transition } = await world();
    transition("stopped", REASON);
    const card = dashboardViews(service).dashboard("csrf").needsYou[0]!;
    expect(card.stopSummary).toBeNull();
    expect(card.stopHeadline).toBe(LONG_FIRST_LINE.slice(0, STOP_SUMMARY_MAX_LENGTH));
    expect(card.stopHeadline).toHaveLength(STOP_SUMMARY_MAX_LENGTH);
    expect(card.reason).toBe(REASON);
    store.close();
  });

  test("a summary recorded for an earlier stop is not shown after the item resumes and stops again", async () => {
    const { service, store, transition } = await world();
    const first = transition("stopped", "Old stop reason.\nmore");
    store.recordStopSummary({ issueId: "item", stopId: first, summary: "Old advice." });
    transition("resumed", null);
    transition("stopped", "New stop reason.\nmore");
    const card = dashboardViews(service).dashboard("csrf").needsYou[0]!;
    expect(card.stopSummary).toBeNull();
    expect(card.stopHeadline).toBe("New stop reason.");
    const html = renderDashboard(dashboardViews(service).dashboard("csrf"));
    expect(html).not.toContain("Old advice.");
    expect(html).toContain("<p>New stop reason.</p>");
    store.close();
  });

  test("recording a summary posts no conversation message or source mutation and leaves the recorded reason whole", async () => {
    const { service, store, transition } = await world();
    const stopId = transition("stopped", REASON);
    const before = store.listConversationMessages("item").length;
    store.recordStopSummary({ issueId: "item", stopId, summary: "Fix the failing check." });
    expect(store.listConversationMessages("item")).toHaveLength(before);
    expect(store.getLatestSourceMutationByKeyPrefix("")).toBeNull();
    expect(dashboardViews(service).dashboard("csrf").needsYou[0]!.reason).toBe(REASON);
    expect(store.listStageTransitions("item").at(-1)?.reason).toBe(REASON);
    store.close();
  });
});

describe("stop summary documentation", () => {
  test("SPEC.md and docs/dashboard.md describe the summary, the headline fallback and View full result", async () => {
    for (const file of ["SPEC.md", "docs/dashboard.md"]) {
      const text = await Bun.file(path.join(import.meta.dir, "..", "..", file)).text();
      expect(text).toContain("View full result");
      expect(text).toContain("headline");
      expect(text).toContain("first line");
      expect(text).toContain("Operator");
    }
  });
});
