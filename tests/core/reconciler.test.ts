import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { reconcileRepository as reconcile } from "../../src/core/reconciler";
import { ConveyorStore } from "../../src/db/store";
import { ExecutionStore } from "../../src/engine/journal";
import { ItemTodos, TODO_CLOSEOUT_NOTE } from "../../src/engine/todos";
import type { IssueSourceAdapter, SourceIssue } from "../../src/source/types";

const temporaryDirectories: string[] = [];

async function openStore(database?: string): Promise<ConveyorStore> {
  if (database) return ConveyorStore.open(database);
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-reconcile-"));
  temporaryDirectories.push(directory);
  return ConveyorStore.open(path.join(directory, "conveyor.sqlite"));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const labels = {
  enrollment: "conveyor",
  stageTemplate: "conveyor:{stage}",
  states: { done: "conveyor:done", blocked: "conveyor:blocked" },
  metadata: {
    closable: "conveyor:closable",
    noSplit: "conveyor:no-split",
    orderTemplate: "conveyor:order:{number}",
  },
};

type ReconcileInput = Parameters<typeof reconcile>[0];

async function reconcileRepository(input: Omit<ReconcileInput, "source" | "trust" | "extraTrustedLogins"> & {
  source: Pick<IssueSourceAdapter, "listIssues"> & Partial<Pick<IssueSourceAdapter, "getIssue" | "getIssueProvenance">>;
  trust?: ReconcileInput["trust"];
  extraTrustedLogins?: readonly string[];
}): Promise<Awaited<ReturnType<typeof reconcile>>> {
  return reconcile({
    ...input,
    source: {
      ...input.source,
      getIssueProvenance: input.source.getIssueProvenance ?? (async () => ({
        enrollment: { login: "trusted" }, title: { login: "trusted" }, body: { login: "trusted" },
      })),
    },
    trust: input.trust ?? { async isTrusted({ login }) { return login === "trusted"; } },
    extraTrustedLogins: input.extraTrustedLogins ?? [],
  });
}

function issue(number: number, issueLabels: string[], state: "open" | "closed" = "open"): SourceIssue {
  return {
    id: `github:owner/repo#${number}`,
    number,
    url: `https://github.com/owner/repo/issues/${number}`,
    title: `Issue ${number}`,
    body: "Body",
    state,
    labels: issueLabels,
    updatedAt: `2026-01-${String(number).padStart(2, "0")}T00:00:00Z`,
  };
}

describe("reconcileRepository", () => {
  test("keeps a parked question in needs-input when a source refresh lacks its state label", async () => {
    const store = await openStore();
    const common = {
      store, configHash: "hash-1",
      repository: { id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: "repository" },
      stages: ["refinement", "implementation"], labels,
    };
    await reconcileRepository({ ...common, source: { async listIssues() { return [issue(1, ["conveyor", "conveyor:refinement"])]; } } });
    store.openQuestion({ issueId: "github:owner/repo#1", runId: null, prompt: "Which scope?", reason: "Need a decision", options: ["small"] });

    await reconcileRepository({ ...common, source: { async listIssues() { return [issue(1, ["conveyor", "conveyor:refinement"])]; } } });

    expect(store.getIssue("github:owner/repo#1")).toMatchObject({ projectedStage: "refinement", projectedState: "needs-input" });
    expect(store.getStageState("github:owner/repo#1")?.status).toBe("ready");
    store.close();
  });

  test("keeps a parked question active when only the base enrollment label is removed", async () => {
    const store = await openStore();
    const common = {
      store, configHash: "hash-1",
      repository: { id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: "repository" },
      stages: ["refinement", "implementation"], labels,
    };
    await reconcileRepository({ ...common, source: { async listIssues() { return [issue(1, ["conveyor", "conveyor:refinement"])]; } } });
    const enrollment = store.activateEnrollment("github:owner/repo#1");
    const question = store.openQuestion({ issueId: "github:owner/repo#1", runId: null, prompt: "Which scope?", reason: "Need a decision", options: ["small"] });

    await reconcileRepository({ ...common, source: { async listIssues() { return [issue(1, ["conveyor:refinement"])]; } } });

    expect(store.getIssue("github:owner/repo#1")).toMatchObject({ projectedStage: "refinement", projectedState: "needs-input" });
    expect(store.getEnrollment(enrollment.id)).toMatchObject({ status: "active" });
    expect(store.getQuestion(question.id)).toMatchObject({ status: "open", answer: null });
    store.close();
  });

  test("offboards a parked question until the item is enrolled again", async () => {
    const store = await openStore();
    const common = {
      store, configHash: "hash-1",
      repository: { id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: "repository" },
      stages: ["refinement", "implementation"], labels,
    };
    await reconcileRepository({ ...common, source: { async listIssues() { return [issue(1, ["conveyor", "conveyor:refinement"])]; } } });
    const enrollment = store.activateEnrollment("github:owner/repo#1");
    const question = store.openQuestion({ issueId: "github:owner/repo#1", runId: null, prompt: "Which scope?", reason: "Need a decision", options: ["small"] });

    await reconcileRepository({ ...common, source: { async listIssues() { return [issue(1, ["backend"])]; } } });

    expect(store.getIssue("github:owner/repo#1")).toMatchObject({ projectedStage: null, projectedState: "offboarded" });
    expect(store.getEnrollment(enrollment.id)).toMatchObject({ status: "offboarded" });
    expect(store.getQuestion(question.id)).toMatchObject({ status: "open", answer: null });

    await reconcileRepository({ ...common, source: { async listIssues() { return [issue(1, ["conveyor", "conveyor:refinement"])]; } } });

    expect(store.getIssue("github:owner/repo#1")).toMatchObject({ projectedStage: "refinement", projectedState: "needs-input" });
    expect(store.getQuestion(question.id)).toMatchObject({ id: question.id, status: "open", answer: null });
    expect(store.activateEnrollment("github:owner/repo#1").generation).toBe(enrollment.generation + 1);
    store.close();
  });

  test("preserves issue identity and history when a repository address changes", async () => {
    const store = await openStore();
    const repository = {
      id: "repo",
      configName: "repo",
      source: "github",
      address: "old-owner/repo",
      folder: "/srv/repo",
    };
    const oldIssue = {
      ...issue(1, ["conveyor"]),
      id: "github:old-owner/repo#1",
      url: "https://github.com/old-owner/repo/issues/1",
    };
    await reconcileRepository({
      store,
      configHash: "hash-1",
      repository,
      stages: ["refinement"],
      labels,
      source: { async listIssues() { return [oldIssue]; } },
    });
    const enrollment = store.activateEnrollment(oldIssue.id);

    const transferredIssue = {
      ...oldIssue,
      id: "github:new-owner/repo#1",
      url: "https://github.com/new-owner/repo/issues/1",
      updatedAt: "2026-02-01T00:00:00Z",
    };
    const result = await reconcileRepository({
      store,
      configHash: "hash-2",
      repository: { ...repository, address: "new-owner/repo" },
      stages: ["refinement"],
      labels,
      source: { async listIssues() { return [transferredIssue]; } },
    });

    expect(result).toEqual({ seen: 1, enrolled: 0, offboarded: 0, missing: 0 });
    expect(store.listIssues("repo")).toHaveLength(1);
    expect(store.getIssue(oldIssue.id)).toMatchObject({
      id: oldIssue.id,
      sourceUrl: transferredIssue.url,
    });
    expect(store.getIssue(transferredIssue.id)).toBeNull();
    expect(store.activateEnrollment(oldIssue.id).id).toBe(enrollment.id);
    store.close();
  });

  test("projects source truth and queues only newly enrolled issues", async () => {
    const store = await openStore();
    const sourceIssues = [
      issue(1, ["conveyor"]),
      issue(2, ["backend"]),
      issue(3, ["conveyor", "conveyor:review"]),
    ];

    const result = await reconcileRepository({
      store,
      configHash: "hash-1",
      repository: {
        id: "repo",
        configName: "repo",
        source: "github",
        address: "owner/repo",
        folder: "/srv/repo",
      },
      stages: ["refinement", "implementation", "review"],
      labels,
      source: { async listIssues() { return sourceIssues; } },
    });

    expect(result).toEqual({ seen: 3, enrolled: 2, offboarded: 0, missing: 0 });
    expect(store.listIssues("repo").map((stored) => stored.sourceNumber)).toEqual([1, 3]);
    expect(store.getIssue(sourceIssues[0]!.id)).toMatchObject({
      projectedStage: "refinement",
      projectedState: "active",
      queueRank: 10,
    });
    expect(store.getIssue(sourceIssues[2]!.id)).toMatchObject({
      projectedStage: "review",
      queueRank: 20,
    });
    expect(store.getStageState(sourceIssues[2]!.id)).toMatchObject({
      stageId: "review",
      status: "ready",
    });
    store.close();
  });

  test("onboards an enrolled issue first stored as an offboarded dependency", async () => {
    const store = await openStore();
    const repository = { id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: "/srv/repo" };
    const dependency = issue(2, []);
    store.upsertRepository({ ...repository, configHash: "hash-1" });
    store.upsertIssue({
      id: dependency.id,
      repositoryId: "repo",
      sourceNumber: dependency.number,
      sourceUrl: dependency.url,
      title: dependency.title,
      body: dependency.body,
      sourceState: dependency.state,
      sourceStateReason: null,
      labels: dependency.labels,
      sourceUpdatedAt: dependency.updatedAt,
    });
    store.setIssueProjection(dependency.id, { stage: null, state: "offboarded", warning: null });

    const result = await reconcileRepository({
      store,
      configHash: "hash-1",
      repository,
      stages: ["refinement"],
      labels,
      source: { async listIssues() { return [issue(2, ["conveyor", "conveyor:refinement"])]; } },
    });

    expect(result).toEqual({ seen: 1, enrolled: 1, offboarded: 0, missing: 0 });
    expect(store.getIssue(dependency.id)).toMatchObject({
      queueRank: 10,
      projectedStage: "refinement",
      projectedState: "active",
    });
    expect(store.getStageState(dependency.id)).toMatchObject({ stageId: "refinement", status: "ready" });
    expect(store.listStageTransitions(dependency.id).filter((transition) => transition.kind === "onboarded")).toHaveLength(1);
    store.close();
  });

  test("leaves an unenrolled issue first stored as a dependency offboarded", async () => {
    const store = await openStore();
    const repository = { id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: "/srv/repo" };
    const dependency = issue(2, []);
    store.upsertRepository({ ...repository, configHash: "hash-1" });
    store.upsertIssue({
      id: dependency.id,
      repositoryId: "repo",
      sourceNumber: dependency.number,
      sourceUrl: dependency.url,
      title: dependency.title,
      body: dependency.body,
      sourceState: dependency.state,
      sourceStateReason: null,
      labels: dependency.labels,
      sourceUpdatedAt: dependency.updatedAt,
    });
    store.setIssueProjection(dependency.id, { stage: null, state: "offboarded", warning: null });

    const result = await reconcileRepository({
      store,
      configHash: "hash-1",
      repository,
      stages: ["refinement"],
      labels,
      source: { async listIssues() { return [dependency]; } },
    });

    expect(result).toEqual({ seen: 1, enrolled: 0, offboarded: 0, missing: 0 });
    expect(store.getIssue(dependency.id)).toMatchObject({ queueRank: null, projectedStage: null, projectedState: "offboarded" });
    expect(store.getStageState(dependency.id)).toBeNull();
    expect(store.listStageTransitions(dependency.id).filter((transition) => transition.kind === "onboarded")).toHaveLength(0);
    store.close();
  });

  test("repairs a missing queue rank once without duplicating onboarding", async () => {
    const store = await openStore();
    const repository = { id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: "/srv/repo" };
    const enrolled = issue(2, ["conveyor", "conveyor:refinement"]);
    store.upsertRepository({ ...repository, configHash: "hash-1" });
    store.upsertIssue({
      id: enrolled.id,
      repositoryId: "repo",
      sourceNumber: enrolled.number,
      sourceUrl: enrolled.url,
      title: enrolled.title,
      body: enrolled.body,
      sourceState: enrolled.state,
      sourceStateReason: null,
      labels: enrolled.labels,
      sourceUpdatedAt: enrolled.updatedAt,
    });
    store.setIssueProjection(enrolled.id, { stage: "refinement", state: "active", warning: null });
    store.setStageState({ issueId: enrolled.id, stageId: "refinement", status: "ready", feedbackCycle: 0, configHash: "hash-1" });
    const input = {
      store,
      configHash: "hash-1",
      repository,
      stages: ["refinement"],
      labels,
      source: { async listIssues() { return [enrolled]; } },
    };

    expect(await reconcileRepository(input)).toEqual({ seen: 1, enrolled: 1, offboarded: 0, missing: 0 });
    const queueRank = store.getIssue(enrolled.id)?.queueRank;
    expect(queueRank).toBe(10);
    expect(await reconcileRepository(input)).toEqual({ seen: 1, enrolled: 0, offboarded: 0, missing: 0 });
    expect(store.getIssue(enrolled.id)?.queueRank).toBe(queueRank);
    expect(store.listStageTransitions(enrolled.id).filter((transition) => transition.kind === "onboarded")).toHaveLength(1);
    store.close();
  });

  test("makes a known issue invisible as soon as its final Conveyor label disappears", async () => {
    const store = await openStore();
    const common = {
      store,
      configHash: "hash-1",
      repository: {
        id: "repo",
        configName: "repo",
        source: "github",
        address: "owner/repo",
        folder: "/srv/repo",
      },
      stages: ["refinement"],
      labels,
    };
    await reconcileRepository({
      ...common,
      source: { async listIssues() { return [issue(1, ["conveyor"])]; } },
    });
    const enrollment = store.activateEnrollment("github:owner/repo#1");

    const result = await reconcileRepository({
      ...common,
      source: { async listIssues() { return [issue(1, ["backend"])]; } },
    });

    expect(result.offboarded).toBe(1);
    expect(store.getIssue("github:owner/repo#1")).toMatchObject({
      labels: ["backend"],
      projectedStage: null,
      projectedState: "offboarded",
      queueRank: 10,
    });
    expect(store.activateEnrollment("github:owner/repo#1").generation).toBe(
      enrollment.generation + 1,
    );
    store.close();
  });

  test("confirms an awaiting label transition before making the new stage ready", async () => {
    const store = await openStore();
    const common = {
      store,
      configHash: "hash-1",
      repository: {
        id: "repo",
        configName: "repo",
        source: "github",
        address: "owner/repo",
        folder: "/srv/repo",
      },
      stages: ["refinement", "review"],
      labels,
    };
    await reconcileRepository({
      ...common,
      source: { async listIssues() { return [issue(1, ["conveyor", "conveyor:refinement"])]; } },
    });
    store.setStageState({
      issueId: "github:owner/repo#1",
      stageId: "review",
      status: "awaiting-source",
      feedbackCycle: 0,
      configHash: "hash-1",
    });

    await reconcileRepository({
      ...common,
      source: { async listIssues() { return [issue(1, ["conveyor", "conveyor:review"])]; } },
    });

    expect(store.getStageState("github:owner/repo#1")).toMatchObject({
      stageId: "review",
      status: "ready",
    });
    store.close();
  });

  test("closes implementation todos when reconciliation recovers a source-only advance", async () => {
    const store = await openStore();
    const common = {
      store,
      configHash: "hash-1",
      repository: { id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: "repository" },
      stages: ["refinement", "implementation", "review"],
      labels,
    };
    await reconcileRepository({
      ...common,
      source: { async listIssues() { return [issue(1, ["conveyor", "conveyor:implementation"])]; } },
    });
    const todos = new ItemTodos(store.sqlite());
    todos.set("github:owner/repo#1", [
      { id: "done", text: "Completed", status: "done", note: "kept" },
      { id: "open", text: "Interrupted", status: "in_progress", note: "working" },
    ], "run", "2026-10-01T00:00:00Z");
    store.setStageState({
      issueId: "github:owner/repo#1",
      stageId: "implementation",
      status: "running",
      feedbackCycle: 0,
      configHash: "hash-1",
    });

    const advanced = {
      ...common,
      source: { async listIssues() { return [issue(1, ["conveyor", "conveyor:review"])]; } },
    };
    await reconcileRepository(advanced);
    const closed = todos.get("github:owner/repo#1")!.items;
    expect(closed).toEqual([
      { id: "done", text: "Completed", status: "done", note: "kept" },
      { id: "open", text: "Interrupted", status: "skipped", note: TODO_CLOSEOUT_NOTE },
    ]);

    await reconcileRepository(advanced);
    expect(todos.get("github:owner/repo#1")!.items).toEqual(closed);
    store.close();
  });

  test("leaves a failed stage in error for its retry backoff, but a relabel to another stage resets it", async () => {
    const store = await openStore();
    const common = {
      store,
      configHash: "hash-1",
      repository: { id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: "repository" },
      stages: ["refinement", "review"],
      labels,
    };
    const at = (stage: string) => ({ ...common, source: { async listIssues() { return [issue(1, ["conveyor", `conveyor:${stage}`])]; } } });
    await reconcileRepository(at("refinement"));
    store.setStageState({ issueId: "github:owner/repo#1", stageId: "refinement", status: "error", feedbackCycle: 0, configHash: "hash-1" });

    // e.g. the webhook from Conveyor's own status-comment update: same stage, must not bypass backoff.
    await reconcileRepository(at("refinement"));
    expect(store.getStageState("github:owner/repo#1")).toMatchObject({ stageId: "refinement", status: "error" });

    await reconcileRepository(at("review"));
    expect(store.getStageState("github:owner/repo#1")).toMatchObject({ stageId: "review", status: "ready" });
    store.close();
  });

  test("removing the error label after retries ran out makes the errored stage ready again", async () => {
    const store = await openStore();
    const common = {
      store,
      configHash: "hash-1",
      repository: { id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: "repository" },
      stages: ["refinement", "implementation"],
      labels: { ...labels, states: { ...labels.states, error: "conveyor:error" } },
    };
    const withLabels = (issueLabels: string[]) => ({ ...common, source: { async listIssues() { return [issue(1, issueLabels)]; } } });
    await reconcileRepository(withLabels(["conveyor", "conveyor:implementation"]));
    // Retries used up: the stage is stopped as error, in the store and on the source.
    store.setStageState({ issueId: "github:owner/repo#1", stageId: "implementation", status: "error", feedbackCycle: 0, configHash: "hash-1" });
    await reconcileRepository(withLabels(["conveyor", "conveyor:implementation", "conveyor:error"]));
    expect(store.getIssue("github:owner/repo#1")?.projectedState).toBe("error");

    // Retry (or a person) removes the error label: the item must be schedulable again.
    await reconcileRepository(withLabels(["conveyor", "conveyor:implementation"]));
    expect(store.getStageState("github:owner/repo#1")).toMatchObject({ stageId: "implementation", status: "ready" });
    store.close();
  });

  test("records an onboarded journey entry once, when an item is first enrolled", async () => {
    const store = await openStore();
    const common = {
      store,
      configHash: "hash-1",
      repository: { id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: "repository" },
      stages: ["refinement", "implementation"],
      labels,
    };
    const at = (stage: string) => ({ ...common, source: { async listIssues() { return [issue(1, ["conveyor", `conveyor:${stage}`])]; } } });
    await reconcileRepository(at("refinement"));
    await reconcileRepository(at("refinement"));
    await reconcileRepository(at("implementation"));
    const onboarded = store.listStageTransitions("github:owner/repo#1").filter((transition) => transition.kind === "onboarded");
    expect(onboarded).toHaveLength(1);
    expect(onboarded[0]).toMatchObject({ toStage: "refinement", status: "completed" });
    expect(onboarded[0]!.reason).toBe("Enrolled: the conveyor label was added at refinement.");
    store.close();
  });

  test("records a journey entry when a stopped item resumes, and none when nothing changed", async () => {
    const store = await openStore();
    const common = {
      store,
      configHash: "hash-1",
      repository: { id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: "repository" },
      stages: ["refinement", "implementation"],
      labels,
    };
    const withLabels = (issueLabels: string[]) => ({ ...common, source: { async listIssues() { return [issue(1, issueLabels)]; } } });
    await reconcileRepository(withLabels(["conveyor", "conveyor:implementation", "conveyor:blocked"]));
    // Enrolment's onboarded entry can share a millisecond with the resume, so it is left out of the count.
    const recorded = () => store.listStageTransitions("github:owner/repo#1").filter((transition) => transition.kind !== "onboarded");
    const before = recorded().length;

    await reconcileRepository(withLabels(["conveyor", "conveyor:implementation"]));
    await reconcileRepository(withLabels(["conveyor", "conveyor:implementation"]));

    const added = recorded().slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      kind: "resumed",
      fromStage: "implementation",
      toStage: "implementation",
      reason: "Resumed from blocked: the blocked label was removed.",
    });
    store.close();
  });

  test("stops scheduling closed and missing source issues with visible reasons", async () => {
    const store = await openStore();
    const common = {
      store,
      configHash: "hash-1",
      repository: {
        id: "repo",
        configName: "repo",
        source: "github",
        address: "owner/repo",
        folder: "/srv/repo",
      },
      stages: ["refinement"],
      labels,
    };
    await reconcileRepository({
      ...common,
      source: { async listIssues() { return [issue(1, ["conveyor"]), issue(2, ["conveyor"])]; } },
    });

    const result = await reconcileRepository({
      ...common,
      source: { async listIssues() { return [issue(1, ["conveyor"], "closed")]; } },
    });

    expect(result.missing).toBe(1);
    expect(store.getIssue("github:owner/repo#1")).toMatchObject({
      projectedState: "closed",
      warning: expect.stringContaining("closed before"),
    });
    expect(store.getIssue("github:owner/repo#2")).toMatchObject({
      projectedState: "missing",
      warning: expect.stringContaining("not returned"),
    });
    store.close();
  });

  test("relabelling, pausing and offboarding fence the item once each, and a no-op pass does not", async () => {
    const store = await openStore();
    const journal = new ExecutionStore(store.sqlite());
    const id = "github:owner/repo#1";
    const common = {
      store,
      configHash: "hash-1",
      repository: { id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: "/srv/repo" },
      stages: ["refinement", "review"],
      labels,
    };
    const pass = (issueLabels: string[]) =>
      reconcileRepository({ ...common, source: { async listIssues() { return [issue(1, issueLabels)]; } } });

    await pass(["conveyor", "conveyor:refinement"]);
    store.activateEnrollment(id);
    const enrolled = journal.stageEpoch(id);

    await pass(["conveyor", "conveyor:refinement"]);
    expect(journal.stageEpoch(id)).toBe(enrolled);

    await pass(["conveyor", "conveyor:refinement", "conveyor:blocked"]);
    const paused = journal.stageEpoch(id);
    expect(paused).toBeGreaterThan(enrolled);
    await pass(["conveyor", "conveyor:refinement", "conveyor:blocked"]);
    expect(journal.stageEpoch(id)).toBe(paused);

    await pass(["conveyor", "conveyor:refinement"]);
    const resumed = journal.stageEpoch(id);
    expect(resumed).toBeGreaterThan(paused);

    await pass(["backend"]);
    expect(journal.stageEpoch(id)).toBeGreaterThan(resumed);
    store.close();
  });

  test("requires a trusted effective labeler for initial and renewed enrollment", async () => {
    const store = await openStore();
    const common = {
      store, configHash: "hash-1",
      repository: { id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: "repository" },
      stages: ["refinement"], labels,
      trust: { async isTrusted({ login }: { login: string | null }) { return login === "maintainer"; } },
      extraTrustedLogins: [],
    };
    let labeler: string | null = "outsider";
    let live = { ...issue(1, ["conveyor", "conveyor:refinement"]), title: "Untrusted author's title", body: "Untrusted author's body" };
    const source = {
      async listIssues() { return [live]; },
      async getIssueProvenance() { return { enrollment: { login: labeler }, title: null, body: null }; },
    };

    await reconcileRepository({ ...common, source });
    expect(store.getIssue(live.id)).toMatchObject({ title: "", body: "", projectedState: "offboarded", warning: expect.stringContaining("@outsider") });

    labeler = "maintainer";
    await reconcileRepository({ ...common, source });
    expect(store.getIssue(live.id)).toMatchObject({ title: "Untrusted author's title", body: "Untrusted author's body", projectedState: "active", warning: null });

    live = { ...live, labels: ["backend"] };
    await reconcileRepository({ ...common, source });
    labeler = "outsider";
    live = { ...live, labels: ["conveyor", "conveyor:refinement"] };
    await reconcileRepository({ ...common, source });
    expect(store.getIssue(live.id)).toMatchObject({ projectedState: "offboarded", warning: expect.stringContaining("@outsider") });
    store.close();
  });

  test("keeps untrusted field edits out of the accepted snapshot until a trusted edit adopts them", async () => {
    const store = await openStore();
    const common = {
      store, configHash: "hash-1",
      repository: { id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: "repository" },
      stages: ["refinement"], labels, extraTrustedLogins: [],
      trust: { async isTrusted({ login }: { login: string | null }) { return login === "maintainer"; } },
    };
    let live = { ...issue(1, ["conveyor", "conveyor:refinement"]), title: "Baseline title", body: "Baseline body" };
    let provenance = { enrollment: { login: "maintainer" }, title: null as { login: string | null } | null, body: null as { login: string | null } | null };
    const source = { async listIssues() { return [live]; }, async getIssueProvenance() { return provenance; } };

    await reconcileRepository({ ...common, source });
    live = { ...live, title: "Trusted title", body: "Skipped body" };
    provenance = { ...provenance, title: { login: "maintainer" }, body: { login: "outsider" } };
    await reconcileRepository({ ...common, source });
    expect(store.getIssue(live.id)).toMatchObject({ title: "Trusted title", body: "Baseline body", warning: expect.stringContaining("body edit by @outsider") });

    provenance = { ...provenance, body: { login: "maintainer" } };
    await reconcileRepository({ ...common, source });
    expect(store.getIssue(live.id)).toMatchObject({ title: "Trusted title", body: "Skipped body", warning: null });

    live = { ...live, title: "Skipped title" };
    provenance = { ...provenance, title: { login: "outsider" } };
    await reconcileRepository({ ...common, source });
    expect(store.getIssue(live.id)).toMatchObject({ title: "Trusted title", body: "Skipped body", warning: expect.stringContaining("title edit by @outsider") });

    provenance = { ...provenance, title: { login: "maintainer" } };
    await reconcileRepository({ ...common, source });
    expect(store.getIssue(live.id)).toMatchObject({ title: "Skipped title", body: "Skipped body", warning: null });
    store.close();
  });

  test("blocks unverifiable enrollment until source provenance can be read", async () => {
    const store = await openStore();
    const common = {
      store, configHash: "hash-1",
      repository: { id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: "repository" },
      stages: ["refinement"], labels, extraTrustedLogins: [],
      trust: { async isTrusted() { return true; } },
    };
    const live = { ...issue(1, ["conveyor", "conveyor:refinement"]), title: "Safe only after evidence", body: "Body" };
    let available = false;
    const source = {
      async listIssues() { return [live]; },
      async getIssueProvenance() {
        if (!available) throw new Error("temporary source failure");
        return { enrollment: { login: "maintainer" }, title: null, body: null };
      },
    };
    await reconcileRepository({ ...common, source });
    expect(store.getIssue(live.id)).toMatchObject({ title: "", projectedState: "offboarded", warning: expect.stringContaining("could not be verified") });
    available = true;
    await reconcileRepository({ ...common, source });
    expect(store.getIssue(live.id)).toMatchObject({ title: "Safe only after evidence", projectedState: "active", warning: null });
    store.close();
  });

  test("keeps the accepted snapshot through restart and repeated webhook reconciliation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-reconcile-"));
    temporaryDirectories.push(directory);
    const database = path.join(directory, "conveyor.sqlite");
    let store = await openStore(database);
    const common = {
      configHash: "hash-1",
      repository: { id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: "repository" },
      stages: ["refinement"], labels, extraTrustedLogins: [],
      trust: { async isTrusted({ login }: { login: string | null }) { return login === "maintainer"; } },
    };
    let live = { ...issue(1, ["conveyor", "conveyor:refinement"]), title: "Accepted title", body: "Accepted body" };
    let webhook = false;
    const source = {
      async listIssues() { return webhook ? [] : [live]; },
      async getIssue() { return live; },
      async getIssueProvenance() {
        return { enrollment: { login: "maintainer" }, title: null, body: live.body === "Skipped body" ? { login: "outsider" } : null };
      },
    };

    await reconcileRepository({ ...common, store, source });
    store.close();
    store = await openStore(database);
    live = { ...live, body: "Skipped body" };
    webhook = true;
    await reconcileRepository({ ...common, store, source, includeIssueNumbers: [live.number] });
    const afterWebhook = store.getIssue(live.id)!;
    expect(afterWebhook).toMatchObject({ title: "Accepted title", body: "Accepted body", warning: expect.stringContaining("body edit by @outsider") });
    const transitions = store.listStageTransitions(live.id);

    await reconcileRepository({ ...common, store, source, includeIssueNumbers: [live.number] });
    expect(store.getIssue(live.id)).toMatchObject({ title: "Accepted title", body: "Accepted body", warning: afterWebhook.warning });
    expect(store.listStageTransitions(live.id)).toEqual(transitions);
    store.close();
  });
});
