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
  test("pages from the 24-hour window into older mixed activity without gaps", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-recent-paging-"));
    directories.push(root);
    const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
    const config = {
      hash: "config-hash", root,
      settings: { workspaces: path.join(root, "workspaces"), runners: 1 },
      runners: {}, sources: { github: { type: "github" } }, agents: {},
      labels: { enrollment: "conveyor", stageTemplate: "conveyor:{stage}", states: {}, metadata: { closable: "conveyor:closable" } },
      pipelines: { default: { successStatuses: ["done"], failureStatuses: ["blocked"], stages: ["intake", "review", "cleanup"].map((id) => ({ id, run: { type: "agent", agent: "implementer" }, concurrency: 1, failurePolicies: {}, afterSuccess: [] })) } },
      repositories: { alpha: { source: "github", address: "owner/alpha", folder: root, baseBranch: "main", pipeline: "default", concurrency: 1, systemLabels: [] } },
    } as unknown as ConveyorConfig;
    store.upsertRepository({ id: "alpha", configName: "alpha", source: "github", address: "owner/alpha", folder: root, configHash: config.hash });
    const eventTime = (index: number) => index < 48
      ? `2026-10-15T11:${String(59 - index).padStart(2, "0")}:00.000Z`
      : `2026-10-13T12:${String(59 - index).padStart(2, "0")}:00.000Z`;
    for (let index = 0; index < 52; index += 1) {
      const id = `item-${index}`;
      store.upsertIssue({ id, repositoryId: "alpha", sourceNumber: index + 1, sourceUrl: `https://example.test/${id}`, title: `${id} title`, body: "", sourceState: index % 3 === 1 ? "closed" : "open", labels: [], sourceUpdatedAt: "2026-10-15T00:00:00.000Z" });
      if (index % 3 === 0) {
        store.beginStageTransition({ id: `transition-${id}`, issueId: id, fromStage: "review", toStage: "cleanup", kind: "advance", sourceMutationId: null, detail: { reason: "moved forward", requiredFixes: [], resultStatus: null } });
        store.completeStageTransition(`transition-${id}`);
        store.sqlite().query("UPDATE stage_transitions SET created_at = ? WHERE id = ?").run(eventTime(index), `transition-${id}`);
      } else if (index % 3 === 1) {
        store.setIssueProjection(id, { stage: "cleanup", state: "active", warning: null });
        store.setIssueProjection(id, { stage: "cleanup", state: "done", warning: null });
        store.sqlite().query("UPDATE push_events SET created_at = ? WHERE category = 'done' AND target = ?").run(eventTime(index), id);
      } else {
        store.activateEnrollment(id);
        store.upsertPullRequest({ issueId: id, id: `pr-${id}`, number: index + 1, url: `https://example.test/pr/${index + 1}`, state: "merged", mergedAt: eventTime(index) });
        store.sqlite().query("UPDATE issues SET projected_stage = ?, projected_state = ? WHERE id = ?").run("cleanup", "done", id);
      }
    }

    const now = spyOn(Date, "now").mockReturnValue(new Date("2026-10-15T12:00:00.000Z").valueOf());
    try {
      const service = new ConveyorService(config, store, {} as never);
      const first = service.dashboard("csrf", page()).recent!;
      expect(first.events).toHaveLength(48);
      expect(first.nextCursor).not.toBeNull();
      const second = service.dashboard("csrf", page([], [], first.nextCursor)).recent!;
      expect(second.events).toHaveLength(4);
      expect(second.nextCursor).toBeNull();
      expect([...first.events, ...second.events].map((event) => event.id)).toHaveLength(52);
      expect(new Set([...first.events, ...second.events].map((event) => event.id))).toHaveLength(52);
      expect(second.events.every((event) => event.occurredAt < "2026-10-14T12:00:00.000Z")).toBe(true);
    } finally {
      now.mockRestore();
      store.close();
    }
  });

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
      ["offboarded", "alpha", "advance", "review", "cleanup", null],
    ] as const;
    for (const [index, [id, repositoryId, kind, fromStage, toStage, resultStatus]] of kinds.entries()) {
      store.upsertIssue({ id, repositoryId, sourceNumber: index + 1, sourceUrl: `https://example.test/${id}`, title: `${id} issue`, body: "", sourceState: "open", labels: [], sourceUpdatedAt: "2026-10-15T00:00:00.000Z" });
      store.beginStageTransition({ id: `transition-${id}`, issueId: id, fromStage, toStage, kind, sourceMutationId: null, detail: { reason: `${id} reason`, requiredFixes: [], resultStatus } });
      store.completeStageTransition(`transition-${id}`);
      store.sqlite().query("UPDATE stage_transitions SET created_at = ? WHERE id = ?").run(`2026-10-15T12:0${9 - index}:00.000Z`, `transition-${id}`);
    }
    store.setIssueProjection("offboarded", { stage: null, state: "offboarded", warning: null });
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
      expect(all.events.some((event) => event.issueNumber === 7)).toBe(false);

      const doneAndStopped = service.dashboard("csrf", page(["done", "stopped"])).recent!;
      expect(doneAndStopped.events.map((event) => event.type)).toEqual(["done", "done", "stopped"]);
      expect(service.dashboard("csrf", page([], ["alpha"])).recent!.events.every((event) => event.repository === "alpha")).toBe(true);
      expect(all.types).not.toContain("rollup");

      for (let index = 0; index < 501; index += 1) {
        const id = `unmatched-${index}`;
        store.upsertIssue({ id, repositoryId: "alpha", sourceNumber: 1000 + index, sourceUrl: `https://example.test/${id}`, title: `${id} issue`, body: "", sourceState: "open", labels: [], sourceUpdatedAt: "2026-10-15T00:00:00.000Z" });
        store.beginStageTransition({ id: `transition-${id}`, issueId: id, fromStage: "review", toStage: "cleanup", kind: "advance", sourceMutationId: null, detail: { reason: "moved forward", requiredFixes: [], resultStatus: null } });
        store.completeStageTransition(`transition-${id}`);
        store.sqlite().query("UPDATE stage_transitions SET created_at = ? WHERE id = ?").run("2026-10-15T12:00:00.000Z", `transition-${id}`);
      }
      const bounded = service.dashboard("csrf", page(["stopped"], ["alpha"])).recent!;
      expect(bounded.events).toEqual([]);
      expect(bounded.nextCursor).not.toBeNull();
      expect(service.dashboard("csrf", page(["done"], ["missing"])).recent).toMatchObject({ events: [], nextCursor: null });
    } finally {
      now.mockRestore();
      store.close();
    }
  });
});
