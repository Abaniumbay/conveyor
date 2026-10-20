import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ExternalWaitError } from "../../src/app/ci-gate";
import { IssueExecutor } from "../../src/app/issue-executor";
import { loadConfig, type ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import type { PipelineDependencies } from "../../src/core/pipeline";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const success = {
  stageResult: { outcome: "success" as const, status: "done", summary: "ok", reason: null, metrics: {} },
  sessionId: null,
  usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
  cost: { amount: 0, currency: "USD" as const, source: "unavailable" as const },
  durationMs: 1,
  exitCode: 0,
  artifacts: [],
  stderr: "",
};

/** Configuration variants: another repository, or a different agent for one stage. */
interface Variant {
  otherRepository?: boolean;
  implementationAgent?: string;
  reviewAgent?: string;
}

function configText(root: string, variant: Variant = {}): string {
  const other = variant.otherRepository
    ? `
  other:
    source: github
    address: owner/other
    folder: ${path.join(root, "other")}
    pipeline: default`
    : "";
  return `
settings:
  database: ${root}/db.sqlite
  logs: ${root}/logs
  workspaces: ${root}/workspaces
  artifacts: ${root}/artifacts
web: {}
sources: { github: { type: github } }
runners: { codex: { type: codex } }
agents:
  worker: { runner: codex, instructions: ./instructions.md }
  helper: { runner: codex, instructions: ./instructions.md }
checks: {}
labels:
  enrollment: conveyor
  stageTemplate: "conveyor:{stage}"
  states: { done: "conveyor:done", blocked: "conveyor:blocked" }
  metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" }
pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked]
    stages:
      - id: implementation
        run: { agent: ${variant.implementationAgent ?? "worker"} }
        concurrency: 1
      - id: review
        run: { agent: ${variant.reviewAgent ?? "worker"} }
        concurrency: 1
repositories:
  repo:
    source: github
    address: owner/repo
    folder: ${path.join(root, "repo")}
    pipeline: default${other}
`;
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-parked-"));
  directories.push(root);
  const repositoryPath = path.join(root, "repo");
  await mkdir(repositoryPath);
  await mkdir(path.join(root, "other"));
  await writeFile(path.join(root, "instructions.md"), "Work.");
  await writeFile(path.join(root, "config.yml"), configText(root));
  const config = await loadConfig(path.join(root, "config.yml"));
  const store = await ConveyorStore.open(config.settings.database);
  store.upsertRepository({
    id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: repositoryPath, configHash: config.hash,
  });
  store.upsertIssue({
    id: "issue", repositoryId: "repo", sourceNumber: 7, sourceUrl: "https://example.test/7", title: "A feature",
    body: "Requirements", sourceState: "open", labels: ["conveyor", "conveyor:implementation"],
    sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  store.setIssueProjection("issue", { stage: "implementation", state: "active", warning: null });
  store.setStageState({ issueId: "issue", stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: config.hash });
  const labels: string[][] = [];
  const producers: string[] = [];
  let failure = false;
  let fenceNextProducer = false;
  let inFlightReason: string | null = null;
  let wait: ExternalWaitError | null = new ExternalWaitError("Waiting for CI at abc1234: Tests.", 60_000, "CI started");
  const executorFor = (current: ConveyorConfig) => new IssueExecutor({
    config: current,
    store,
    sourceName: "github",
    source: { async replaceConveyorLabels(_address, _number, next) { labels.push([...next]); } },
    workspaceManager: { async create() { return { path: path.join(root, "worktree"), branch: "conveyor/7", baseRevision: "abc" }; } },
    loadDeliveryState: async () => ({ pullRequest: null, checks: [] }),
    runtime: () => ({
      async runCheck() { throw new Error("no checks"); },
      async runProducer(stage) {
        producers.push(stage.id);
        if (fenceNextProducer) {
          fenceNextProducer = false;
          store.openQuestion({ issueId: "issue", runId: null, prompt: "Which database?", reason: "need it", options: [], allowFreeText: true });
          store.setIssueProjection("issue", { stage: "implementation", state: "needs-input", warning: "Waiting for an answer: Which database?" });
        }
        if (wait) throw wait;
        if (failure) return { ...success, stageResult: { ...success.stageResult, outcome: "failure" as const, status: "blocked", reason: "nope" } };
        return success;
      },
      async runAction() {},
    } satisfies PipelineDependencies),
    sourceGuidance: "",
    admitInFlight: () => inFlightReason,
  });
  return {
    config, store, labels, producers, executorFor,
    async variant(variant: Variant): Promise<ConveyorConfig> {
      const file = path.join(root, `config-${Object.keys(variant).join("-")}.yml`);
      await writeFile(file, configText(root, variant));
      return loadConfig(file);
    },
    stopWaiting() { wait = null; },
    holdInFlight(reason: string) { inFlightReason = reason; },
    releaseInFlight() { inFlightReason = null; },
    failNext() { wait = null; failure = true; },
    fenceNextProducer() { fenceNextProducer = true; },
    messages: () => store.listConversationMessages("issue").map((message) => message.message),
  };
}

describe("IssueExecutor parked stages", () => {
  test("holds a completed prior stage without rerunning it until an in-flight slot opens", async () => {
    const h = await setup();
    h.stopWaiting();
    h.holdInFlight("Waiting for an in-progress slot in repo: #3, #5");

    const blocked = await h.executorFor(h.config).execute(h.store.getIssue("issue")!);

    expect(blocked).toMatchObject({ kind: "parked", stageId: "implementation", reason: "pending" });
    expect(h.labels).toEqual([]);
    expect(h.producers).toEqual(["implementation"]);
    expect(h.store.getStageState("issue")).toMatchObject({ stageId: "implementation", status: "waiting-in-flight" });
    expect(h.store.getIssue("issue")?.warning).toBe("Waiting for an in-progress slot in repo: #3, #5");

    h.releaseInFlight();
    const waiting = h.store.getStageState("issue")!;
    h.store.setStageState({ ...waiting, status: "ready", configHash: h.config.hash });
    const advanced = await h.executorFor(h.config).execute(h.store.getIssue("issue")!);

    expect(advanced).toMatchObject({ kind: "advance", nextStageId: "review" });
    expect(h.producers).toEqual(["implementation"]);
    expect(h.labels).toEqual([["conveyor", "conveyor:review"]]);
    h.store.close();
  });

  test("parks a waiting stage: no transition, stage ready, status line set, wake-up persisted, no duplicate note", async () => {
    const h = await setup();
    const before = Date.now();
    const outcome = await h.executorFor(h.config).execute(h.store.getIssue("issue")!);

    expect(outcome).toMatchObject({ kind: "parked", stageId: "implementation", reason: "pending" });
    expect(h.labels).toEqual([]);
    expect(h.store.getStageState("issue")).toMatchObject({ stageId: "implementation", status: "ready" });
    expect(h.store.getIssue("issue")?.warning).toBe("Waiting for CI at abc1234: Tests.");
    const wake = h.store.executions().wakeAt("issue");
    expect(Date.parse(wake!)).toBeGreaterThanOrEqual(before + 60_000);
    expect(h.messages()).toEqual([]);

    h.stopWaiting();
    const resumed = await h.executorFor(h.config).execute(h.store.getIssue("issue")!);
    expect(resumed).toMatchObject({ kind: "advance", nextStageId: "review" });
    expect(h.store.executions().wakeAt("issue")).toBeNull();
    expect(h.labels).toEqual([["conveyor", "conveyor:review"]]);
    h.store.close();
  });

  test("a stale epoch from a projection change releases the abandoned running stage", async () => {
    const h = await setup();
    h.fenceNextProducer();

    const outcome = await h.executorFor(h.config).execute(h.store.getIssue("issue")!);

    expect(outcome).toMatchObject({ kind: "parked", stageId: "implementation", reason: "superseded" });
    expect(h.store.listOpenQuestions()).toHaveLength(1);
    expect(h.store.getStageState("issue")).toMatchObject({ stageId: "implementation", status: "ready" });
    expect(h.store.listActiveIssueRuns()).toEqual([]);
    expect(h.store.executions().getCursor("issue")).toBeNull();
    h.store.close();
  });

  test("a change to the parked stage's own plan restarts it and says so once", async () => {
    const h = await setup();
    await h.executorFor(h.config).execute(h.store.getIssue("issue")!);
    const epoch = h.store.executions().stageEpoch("issue");

    // Same configuration: resumes quietly.
    await h.executorFor(h.config).execute(h.store.getIssue("issue")!);
    expect(h.store.executions().stageEpoch("issue")).toBe(epoch);
    expect(h.messages()).toEqual([]);

    const changed = await h.variant({ implementationAgent: "helper" });
    await h.executorFor(changed).execute(h.store.getIssue("issue")!);
    expect(h.store.executions().stageEpoch("issue")).toBeGreaterThan(epoch);
    expect(h.store.executions().getContext("issue")?.context.configHash).toBe(changed.hash);
    const notes = h.messages();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/plan changed.*restart/i);
    expect(h.store.listStageTransitions("issue").at(-1)).toMatchObject({
      kind: "restarted", fromStage: "implementation", toStage: "implementation", reason: notes[0],
    });
    expect(h.producers).toEqual(["implementation", "implementation", "implementation"]);

    // The restart recorded the new plan, so the next resume is quiet again.
    await h.executorFor(changed).execute(h.store.getIssue("issue")!);
    expect(h.messages()).toHaveLength(1);
    h.store.close();
  });

  test("adding another repository does not restart a parked stage", async () => {
    const h = await setup();
    await h.executorFor(h.config).execute(h.store.getIssue("issue")!);
    const epoch = h.store.executions().stageEpoch("issue");
    const cursor = h.store.executions().getCursor("issue");

    const changed = await h.variant({ otherRepository: true });
    expect(changed.hash).not.toBe(h.config.hash);
    await h.executorFor(changed).execute(h.store.getIssue("issue")!);

    expect(h.store.executions().stageEpoch("issue")).toBe(epoch);
    expect(h.store.executions().getCursor("issue")).toMatchObject({ stage: "implementation", stageEpoch: cursor?.stageEpoch });
    expect(h.messages()).toEqual([]);
    expect(h.store.listStageTransitions("issue").filter((transition) => transition.kind === "restarted")).toEqual([]);
    h.store.close();
  });

  test("changing another stage of the same pipeline does not restart a parked stage", async () => {
    const h = await setup();
    await h.executorFor(h.config).execute(h.store.getIssue("issue")!);
    const epoch = h.store.executions().stageEpoch("issue");

    const changed = await h.variant({ reviewAgent: "helper" });
    expect(changed.hash).not.toBe(h.config.hash);
    await h.executorFor(changed).execute(h.store.getIssue("issue")!);

    expect(h.store.executions().stageEpoch("issue")).toBe(epoch);
    expect(h.messages()).toEqual([]);
    h.store.close();
  });

  test("a context stored without a stage plan hash falls back to the configuration hash", async () => {
    const h = await setup();
    await h.executorFor(h.config).execute(h.store.getIssue("issue")!);
    // A context as written before stage plan hashes existed.
    const journal = h.store.executions();
    const stored = journal.getContext("issue")!;
    const { stagePlanHash: _hash, ...legacyContext } = stored.context;
    journal.saveContext("issue", legacyContext, {
      stage: "implementation", taskInstanceId: "legacy.produce", expectedEpoch: stored.stageEpoch,
    });
    const epoch = journal.stageEpoch("issue");

    // Same configuration hash: resumes quietly.
    await h.executorFor(h.config).execute(h.store.getIssue("issue")!);
    expect(journal.stageEpoch("issue")).toBe(epoch);
    expect(h.messages()).toEqual([]);

    // Strip the hash again; a different configuration hash then restarts the stage, even though its plan is unchanged.
    const resumed = journal.getContext("issue")!;
    const { stagePlanHash: _resumedHash, ...again } = resumed.context;
    journal.saveContext("issue", again, {
      stage: "implementation", taskInstanceId: "legacy.produce", expectedEpoch: resumed.stageEpoch,
    });
    await h.executorFor(await h.variant({ otherRepository: true })).execute(h.store.getIssue("issue")!);
    expect(journal.stageEpoch("issue")).toBeGreaterThan(epoch);
    expect(h.messages()).toHaveLength(1);
    h.store.close();
  });

  test("legacy stages post no executor notes, even when they stop", async () => {
    const h = await setup();
    h.failNext();
    const outcome = await h.executorFor(h.config).execute(h.store.getIssue("issue")!);
    expect(outcome).toMatchObject({ kind: "stopped" });
    expect(h.messages()).toEqual([]);
    h.store.close();
  });

  test("clearing the status only removes the pending message the executor set", async () => {
    const h = await setup();
    await h.executorFor(h.config).execute(h.store.getIssue("issue")!);
    // The reconciler replaced the pending message with an unrelated warning.
    h.store.setIssueProjection("issue", { stage: "implementation", state: "active", warning: "Something else" });
    h.stopWaiting();
    await h.executorFor(h.config).execute(h.store.getIssue("issue")!);
    expect(h.store.getIssue("issue")?.warning).toBe("Something else");
    h.store.close();
  });

  test("clearing the status removes the pending message it set", async () => {
    const h = await setup();
    await h.executorFor(h.config).execute(h.store.getIssue("issue")!);
    h.stopWaiting();
    await h.executorFor(h.config).execute(h.store.getIssue("issue")!);
    expect(h.store.getIssue("issue")?.warning).toBeNull();
    h.store.close();
  });
});
