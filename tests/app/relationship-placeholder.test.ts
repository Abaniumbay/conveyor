import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const blocker = {
  id: "github:owner/repo#2", number: 2, url: "https://example.test/2", title: "Source title", body: "Source body",
  state: "open" as const, stateReason: null, labels: ["conveyor", "conveyor:implementation"], updatedAt: "2026-01-02T00:00:00Z",
};

async function setup(onDependencies: (store: ConveyorStore) => void) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-placeholder-"));
  temporaryDirectories.push(root);
  const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
  const config = {
    hash: "config-hash", root,
    settings: { workspaces: path.join(root, "workspaces"), runners: 1 },
    labels: {
      enrollment: "conveyor", stageTemplate: "conveyor:{stage}",
      states: { done: "conveyor:done", blocked: "conveyor:blocked" },
      metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" },
    },
    pipelines: { default: { stages: [{ id: "implementation" }, { id: "review" }] } },
    repositories: { repo: { source: "github", address: "owner/repo", folder: root, pipeline: "default" } },
  } as unknown as ConveyorConfig;
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: root, configHash: config.hash });
  store.upsertIssue({
    id: "github:owner/repo#1", repositoryId: "repo", sourceNumber: 1, sourceUrl: "https://example.test/1", title: "Blocked", body: "Body",
    sourceState: "open", labels: ["conveyor", "conveyor:implementation"], sourceUpdatedAt: "2026-01-01T00:00:00Z", acceptedTextAt: "2026-01-01T00:00:00Z",
  });
  store.setIssueProjection("github:owner/repo#1", { stage: "implementation", state: "active", warning: null });
  const source = {
    async listSubIssues() { return []; },
    async listDependencies() { onDependencies(store); return [blocker]; },
  };
  const service = new ConveyorService(config, store, source as never);
  const pass = () => (service as unknown as { reconcileRelationships(repositoryId: string, address: string): Promise<void> }).reconcileRelationships("repo", "owner/repo");
  return { store, pass };
}

describe("relationship pass blocker placeholders", () => {
  test("a blocker stored and enrolled after the pass began keeps its text, accepted timestamp and projection, and is still recorded as a blocker", async () => {
    const { store, pass } = await setup((current) => {
      current.upsertIssue({
        id: blocker.id, repositoryId: "repo", sourceNumber: 2, sourceUrl: blocker.url, title: "Accepted title", body: "Accepted body",
        sourceState: "open", labels: blocker.labels, sourceUpdatedAt: blocker.updatedAt, acceptedTextAt: blocker.updatedAt,
      });
      current.setIssueProjection(blocker.id, { stage: "implementation", state: "active", warning: null });
    });

    await pass();

    expect(store.getIssue(blocker.id)).toMatchObject({
      title: "Accepted title", body: "Accepted body", acceptedTextAt: blocker.updatedAt, projectedStage: "implementation", projectedState: "active",
    });
    expect(store.listDependencies("github:owner/repo#1")).toEqual([blocker.id]);
    store.close();
  });

  test("a blocker that is still not stored gets the empty offboarded placeholder", async () => {
    const { store, pass } = await setup(() => {});

    await pass();

    const placeholder = store.getIssue(blocker.id)!;
    expect(placeholder).toMatchObject({ title: "", body: "", projectedState: "offboarded" });
    expect(placeholder.acceptedTextAt ?? null).toBeNull();
    expect(store.listDependencies("github:owner/repo#1")).toEqual([blocker.id]);
    store.close();
  });
});
