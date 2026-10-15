import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import type { DashboardPageSelection, RecentActivityType } from "../../src/web/types";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function page(types: readonly RecentActivityType[] = [], repositoryIds: readonly string[] = [], recentCursor: DashboardPageSelection["recentCursor"] = null): DashboardPageSelection {
  return { view: "recent", repositoryId: null, column: null, page: 1, doneLimit: 20, runId: null, issueId: null, repositoryIds, q: "", state: null, recentTypes: types, recentCursor };
}

describe("Recent activity dashboard", () => {
  test("classifies pipeline activity, independently sourced Done events, and combined repository filters", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-recent-"));
    directories.push(root);
    const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
    const config = {
      hash: "config-hash", root,
      settings: { workspaces: path.join(root, "workspaces"), runners: 1 },
      runners: {}, sources: { github: { type: "github" } }, agents: {},
      labels: { enrollment: "conveyor", stageTemplate: "conveyor:{stage}", states: {}, metadata: { closable: "conveyor:closable" } },
      pipelines: { default: { successStatuses: ["done"], failureStatuses: ["blocked"], stages: ["intake", "review", "cleanup"].map((id) => ({ id, run: { type: "agent", agent: "implementer" }, concurrency: 1, failurePolicies: {}, afterSuccess: [] })) } },
      repositories: {
        alpha: { source: "github", address: "owner/alpha", folder: root, baseBranch: "main", pipeline: "default", concurrency: 1, systemLabels: [] },
        beta: { source: "github", address: "owner/beta", folder: root, baseBranch: "main", pipeline: "default", concurrency: 1, systemLabels: [] },
      },
    } as unknown as ConveyorConfig;
    for (const repositoryId of ["alpha", "beta"]) {
      store.upsertRepository({ id: repositoryId, configName: repositoryId, source: "github", address: `owner/${repositoryId}`, folder: root, configHash: config.hash });
    }
    const kinds = [
      ["advanced", "alpha", "advance", "review", "cleanup", null],
      ["returned", "alpha", "correction", "cleanup", "review", null],
      ["stopped", "beta", "observed", "review", "review", "blocked"],
      ["new", "beta", "onboarded", null, "intake", null],
      ["resumed", "alpha", "resumed", "review", "review", null],
      ["rollup", "beta", "rollup", "review", "review", null],
    ] as const;
    for (const [index, [id, repositoryId, kind, fromStage, toStage, resultStatus]] of kinds.entries()) {
      store.upsertIssue({ id, repositoryId, sourceNumber: index + 1, sourceUrl: `https://example.test/${id}`, title: `${id} issue`, body: "", sourceState: "open", labels: [], sourceUpdatedAt: "2026-10-15T00:00:00.000Z" });
      store.beginStageTransition({ id: `transition-${id}`, issueId: id, fromStage, toStage, kind, sourceMutationId: null, detail: { reason: `${id} reason`, requiredFixes: [], resultStatus } });
      store.completeStageTransition(`transition-${id}`);
      store.sqlite().query("UPDATE stage_transitions SET created_at = ? WHERE id = ?").run(`2026-10-15T12:0${9 - index}:00.000Z`, `transition-${id}`);
    }
    store.upsertIssue({ id: "recorded-done", repositoryId: "alpha", sourceNumber: 20, sourceUrl: "https://example.test/recorded", title: "done after a non-advance", body: "", sourceState: "closed", sourceStateReason: "completed", labels: [], sourceUpdatedAt: "2026-10-15T00:00:00.000Z" });
    store.setIssueProjection("recorded-done", { stage: "cleanup", state: "active", warning: null });
    store.setIssueProjection("recorded-done", { stage: "cleanup", state: "done", warning: null });
    store.sqlite().query("UPDATE push_events SET created_at = ? WHERE category = 'done' AND target = ?").run("2026-10-15T12:09:30.000Z", "recorded-done");
    store.beginStageTransition({ id: "transition-after-done", issueId: "recorded-done", fromStage: "cleanup", toStage: "cleanup", kind: "observed", sourceMutationId: null, detail: { reason: "done is an item state", requiredFixes: [], resultStatus: null } });
    store.completeStageTransition("transition-after-done");
    store.sqlite().query("UPDATE stage_transitions SET created_at = ? WHERE id = ?").run("2026-10-15T12:10:00.000Z", "transition-after-done");
    store.upsertIssue({ id: "legacy-done", repositoryId: "beta", sourceNumber: 21, sourceUrl: "https://example.test/legacy", title: "legacy completion", body: "", sourceState: "closed", sourceStateReason: "completed", labels: [], sourceUpdatedAt: "2026-10-15T00:00:00.000Z" });
    store.activateEnrollment("legacy-done");
    store.upsertPullRequest({ issueId: "legacy-done", id: "legacy-pr", number: 21, url: "https://example.test/pr/21", state: "merged", mergedAt: "2026-10-15T12:08:30.000Z" });
    store.sqlite().query("UPDATE issues SET projected_stage = ?, projected_state = ? WHERE id = ?").run("cleanup", "done", "legacy-done");

    const now = spyOn(Date, "now").mockReturnValue(new Date("2026-10-15T12:30:00.000Z").valueOf());
    try {
      const service = new ConveyorService(config, store, {} as never);
      const all = service.dashboard("csrf", page()).recent!;
      expect(all.events.map((event) => event.type)).toEqual(["done", "moved-forward", "done", "sent-back", "stopped", "new", "resumed"]);
      expect(all.events.find((event) => event.issueNumber === 20)).toMatchObject({ type: "done", occurredAt: "2026-10-15T12:09:30.000Z" });
      expect(all.events.filter((event) => event.issueNumber === 20 && event.type === "done")).toHaveLength(1);
      expect(all.events.find((event) => event.issueNumber === 21)).toMatchObject({ type: "done", occurredAt: "2026-10-15T12:08:30.000Z" });

      const doneAndStopped = service.dashboard("csrf", page(["done", "stopped"])).recent!;
      expect(doneAndStopped.events.map((event) => event.type)).toEqual(["done", "done", "stopped"]);
      expect(service.dashboard("csrf", page([], ["alpha"])).recent!.events.every((event) => event.repository === "alpha")).toBe(true);
      expect(all.types).not.toContain("rollup");
    } finally {
      now.mockRestore();
      store.close();
    }
  });
});
