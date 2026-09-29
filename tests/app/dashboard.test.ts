import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("ConveyorService dashboard", () => {
  test("uses only configured stages as columns and sends invalid labels to attention", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-dashboard-"));
    temporaryDirectories.push(root);
    const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
    const config = {
      hash: "config-hash",
      root,
      settings: { workspaces: path.join(root, "workspaces") },
      labels: {
        enrollment: "conveyor",
        stageTemplate: "conveyor:{stage}",
        states: { done: "conveyor:done", blocked: "conveyor:blocked" },
        metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" },
      },
      pipelines: {
        default: {
          stages: [{ id: "refinement" }, { id: "implementation" }],
        },
      },
      repositories: {
        repo: { source: "github", address: "owner/repo", folder: root, pipeline: "default" },
      },
    } as unknown as ConveyorConfig;
    store.upsertRepository({
      id: "repo",
      configName: "repo",
      source: "github",
      address: "owner/repo",
      folder: root,
      configHash: config.hash,
    });
    for (let number = 1; number <= 25; number += 1) {
      const id = `github:owner/repo#${number}`;
      store.upsertIssue({
        id,
        repositoryId: "repo",
        sourceNumber: number,
        sourceUrl: `https://github.com/owner/repo/issues/${number}`,
        title: `Done issue ${number}`,
        body: "",
        sourceState: "open",
        labels: ["conveyor", "conveyor:done"],
        sourceUpdatedAt: "2026-09-29T00:00:00Z",
      });
      store.setIssueProjection(id, { stage: null, state: "done", warning: null });
    }
    store.replaceRelationships(
      "github:owner/repo#25",
      { parentId: "github:owner/repo#1", siblingOrder: 1 },
      [],
    );
    store.upsertIssue({
      id: "github:owner/repo#26",
      repositoryId: "repo",
      sourceNumber: 26,
      sourceUrl: "https://github.com/owner/repo/issues/26",
      title: "Ready issue",
      body: "",
      sourceState: "open",
      labels: ["conveyor", "conveyor:refinement"],
      sourceUpdatedAt: "2026-09-29T00:00:00Z",
    });
    store.setIssueProjection("github:owner/repo#26", {
      stage: "refinement",
      state: "active",
      warning: null,
    });
    store.setStageState({
      issueId: "github:owner/repo#26",
      stageId: "refinement",
      status: "ready",
      feedbackCycle: 0,
      configHash: config.hash,
    });

    const service = new ConveyorService(config, store, {} as never);
    const dashboard = service.dashboard("csrf", { view: "attention", column: "attention", page: 2 });
    const refinement = dashboard.stages.find((column) => column.id === "stage:refinement");

    expect(dashboard.stages.map((column) => column.name)).toEqual(["Refinement", "Implementation"]);
    expect(refinement).toMatchObject({ totalIssues: 1, page: 1, totalPages: 1 });
    expect(dashboard.attention).toMatchObject({ totalIssues: 25, page: 2, totalPages: 2 });
    expect(dashboard.attention.issues).toHaveLength(5);
    expect(dashboard.attention.issues[4]).toMatchObject({
      number: 25,
      parent: { number: 1 },
      reason: "No valid configured stage label is present.",
    });
    expect(dashboard.backlog).toHaveLength(1);
    expect(dashboard.counts).toEqual({ board: 1, backlog: 1, attention: 25 });
    store.close();
  });
});
