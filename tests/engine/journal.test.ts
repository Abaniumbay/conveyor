import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrations } from "../../src/db/migrations";
import { ConveyorStore } from "../../src/db/store";
import {
  ExecutionStore,
  StaleEpochError,
  type StageCursor,
} from "../../src/engine/journal";
import type { TaskContext } from "../../src/tasks/context";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function seed(store: ConveyorStore): void {
  store.recordConfigSnapshot("hash", {});
  store.upsertRepository({
    id: "repo-1",
    configName: "sample",
    source: "github",
    address: "owner/sample",
    folder: "/srv/sample",
    configHash: "hash",
  });
  store.upsertIssue({
    id: "issue-1",
    repositoryId: "repo-1",
    sourceNumber: 1,
    sourceUrl: "https://example.test/1",
    title: "T",
    body: "B",
    sourceState: "open",
    labels: [],
    sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
  });
}

async function setup(options: { contextSummaryBytes?: number } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-journal-"));
  temporaryDirectories.push(directory);
  const store = await ConveyorStore.open(path.join(directory, "conveyor.sqlite"));
  seed(store);
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
  const journal = new ExecutionStore(store.sqlite(), { ...options, now: clock });
  return { store, journal };
}

function context(extra: Partial<TaskContext> = {}): TaskContext {
  return {
    schemaVersion: 1,
    configHash: "hash",
    run: {
      stage: "implementation",
      stageEpoch: 0,
      attempt: 1,
      maxAttempts: 3,
      taskInstanceId: "t1",
      enteredAt: "2026-01-01T00:00:00.000Z",
      feedback: null,
    },
    repository: { id: "repo-1", address: "owner/sample", folder: "/srv/sample", baseBranch: "main", ciMode: "required", systemLabels: [] },
    item: {
      id: "issue-1", number: 1, title: "T", url: "u", labels: [], state: "open",
      criteria: [], children: [], dependencies: [], systemLabels: [],
    },
    checkpoints: { ciPassed: null, reviewPassed: null },
    ...extra,
  };
}

const plan = {
  itemId: "issue-1",
  stage: "implementation",
  stageEpoch: 0,
  attempt: 1,
  list: "actions" as const,
  taskInstanceId: "t1",
};

describe("ExecutionStore context", () => {
  test("saves versions, appends history and fences by epoch", async () => {
    const { store, journal } = await setup();
    expect(journal.getContext("issue-1")).toBeNull();

    const first = journal.saveContext("issue-1", context(), { stage: "implementation", taskInstanceId: "t1", expectedEpoch: 0 });
    const second = journal.saveContext("issue-1", context({ configHash: "h2" }), { stage: "implementation", taskInstanceId: "t2", expectedEpoch: 0 });
    expect([first, second]).toEqual([1, 2]);
    expect(journal.getContext("issue-1")).toMatchObject({ version: 2, stageEpoch: 0, context: { configHash: "h2" } });

    const history = journal.contextHistory("issue-1");
    expect(history.map((row) => row.version)).toEqual([1, 2]);
    expect(history.map((row) => row.taskInstanceId)).toEqual(["t1", "t2"]);
    expect(history[0]!.context.configHash).toBe("hash");

    expect(journal.bumpStageEpoch("issue-1")).toBe(1);
    expect(() =>
      journal.saveContext("issue-1", context(), { stage: "implementation", taskInstanceId: "t3", expectedEpoch: 0 }),
    ).toThrow(StaleEpochError);
    expect(journal.contextHistory("issue-1")).toHaveLength(2);
    expect(journal.getContext("issue-1")!.version).toBe(2);
    store.close();
  });

  test("bumpStageEpoch creates the row and stageEpoch defaults to 0", async () => {
    const { store, journal } = await setup();
    expect(journal.stageEpoch("issue-1")).toBe(0);
    expect(journal.bumpStageEpoch("issue-1")).toBe(1);
    expect(journal.bumpStageEpoch("issue-1")).toBe(2);
    expect(journal.stageEpoch("issue-1")).toBe(2);
    expect(journal.getContext("issue-1")).toBeNull();
    expect(journal.saveContext("issue-1", context(), { stage: "s", taskInstanceId: "t", expectedEpoch: 2 })).toBe(1);
    store.close();
  });

  test("shrinks CI logs to fit an oversized context instead of rejecting it", async () => {
    const { store, journal } = await setup({ contextSummaryBytes: 4000 });
    const log = ["❌ a_test.dart: hides the button (failed)", "Expected: nothing", "…", ...Array.from({ length: 200 }, (_, i) => `✅ passing ${i}`)].join("\n");
    const run = { id: "1", name: "Tests", state: "failed" as const, url: null, rerunnable: false, hasLog: true, log };
    const big = context({
      ci: {
        headSha: "h", defined: true, definitionProvable: true, definitionSummary: "", observedAt: "", firstSeenAt: "",
        reruns: [], awaitingStart: [], runs: [run, { ...run, id: "2", name: "Full suite" }],
      },
    });
    expect(journal.saveContext("issue-1", big, { stage: "s", taskInstanceId: "t", expectedEpoch: 0 })).toBe(1);
    const saved = journal.getContext("issue-1")!.context;
    expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(4000);
    expect(saved.ci!.runs[0]!.log).toContain("Expected: nothing");
    store.close();
  });

  test("rejects an oversized context naming the largest key", async () => {
    const { store, journal } = await setup({ contextSummaryBytes: 2000 });
    const big = context({ agent: { agentId: "a", status: "s", summary: "x".repeat(3000), reason: null, sessionId: null, runId: "r" } });
    expect(() =>
      journal.saveContext("issue-1", big, { stage: "s", taskInstanceId: "t", expectedEpoch: 0 }),
    ).toThrow(/"agent"/);
    expect(journal.getContext("issue-1")).toBeNull();
    store.close();
  });
});

describe("ExecutionStore executions", () => {
  test("idempotency key is the sha256 of the NUL-joined fields", async () => {
    const { store, journal } = await setup();
    const fields = { issueId: "i", stage: "s", stageEpoch: 2, attempt: 1, taskInstanceId: "t" };
    const expected = new Bun.CryptoHasher("sha256").update("i\u0000s\u00002\u00001\u0000t").digest("hex");
    expect(journal.idempotencyKey(fields)).toBe(expected);
    expect(journal.idempotencyKey({ ...fields, attempt: 2 })).not.toBe(expected);
    store.close();
  });

  test("planning again returns the same row as resumed", async () => {
    const { store, journal } = await setup();
    const first = journal.planExecution(plan);
    expect(first.resumed).toBe(false);
    expect(first.record).toMatchObject({ state: "planned", recoveryState: "not-needed", idempotencyKey: journal.idempotencyKey({ issueId: "issue-1", stage: "implementation", stageEpoch: 0, attempt: 1, taskInstanceId: "t1" }) });
    journal.markRunning(first.record.id, 0);
    const again = journal.planExecution(plan);
    expect(again.resumed).toBe(true);
    expect(again.record.id).toBe(first.record.id);
    expect(again.record.state).toBe("running");
    store.close();
  });

  test("pending keeps the first pendingSince and deadline", async () => {
    const { store, journal } = await setup();
    const { record } = journal.planExecution(plan);
    journal.markRunning(record.id, 0);
    const a = journal.markPending(record.id, { wakeAt: "2026-02-01T00:00:10.000Z", deadlineAt: "2026-02-01T01:00:00.000Z" }, 0);
    const b = journal.markPending(record.id, { wakeAt: "2026-02-01T00:00:20.000Z", deadlineAt: "2026-02-01T09:00:00.000Z", message: "latest" }, 0);
    expect(b.result).toEqual({ status: "pending", message: "latest" });
    expect(a.pendingSince).not.toBeNull();
    expect(b).toMatchObject({
      state: "pending",
      pendingSince: a.pendingSince,
      deadlineAt: "2026-02-01T01:00:00.000Z",
      wakeAt: "2026-02-01T00:00:20.000Z",
    });
    store.close();
  });

  test("complete and fail store the result", async () => {
    const { store, journal } = await setup();
    const one = journal.planExecution(plan).record;
    expect(journal.completeExecution(one.id, { ok: 1 }, 0)).toMatchObject({ state: "completed", result: { ok: 1 } });
    const two = journal.planExecution({ ...plan, taskInstanceId: "t2" }).record;
    expect(journal.failExecution(two.id, { message: "no" }, 0)).toMatchObject({ state: "failed", result: { message: "no" } });
    store.close();
  });

  test("every execution write is fenced by epoch", async () => {
    const { store, journal } = await setup();
    const { record } = journal.planExecution(plan);
    journal.bumpStageEpoch("issue-1");
    expect(() => journal.planExecution({ ...plan, taskInstanceId: "t9" })).toThrow(StaleEpochError);
    expect(() => journal.markRunning(record.id, 0)).toThrow(StaleEpochError);
    expect(() => journal.markPending(record.id, { wakeAt: null, deadlineAt: null }, 0)).toThrow(StaleEpochError);
    expect(() => journal.completeExecution(record.id, {}, 0)).toThrow(StaleEpochError);
    expect(() => journal.failExecution(record.id, {}, 0)).toThrow(StaleEpochError);
    expect(journal.getExecution(record.id)!.state).toBe("planned");
    store.close();
  });
});

describe("ExecutionStore cursor", () => {
  const cursor: StageCursor = {
    issueId: "issue-1",
    stage: "implementation",
    stageEpoch: 0,
    attempt: 1,
    returns: 0,
    list: "actions",
    taskInstanceId: "t1",
    state: "running",
    feedback: { from: { stage: "review", taskInstanceId: "r1" }, message: "fix" },
    pendingSince: null,
    wakeAt: null,
    deadlineAt: null,
  };

  test("round-trips, clears, and is fenced", async () => {
    const { store, journal } = await setup();
    expect(journal.getCursor("issue-1")).toBeNull();
    journal.saveCursor(cursor, 0);
    expect(journal.getCursor("issue-1")).toEqual(cursor);
    journal.saveCursor({ ...cursor, state: "pending", wakeAt: "2026-03-01T00:00:00.000Z" }, 0);
    expect(journal.wakeAt("issue-1")).toBe("2026-03-01T00:00:00.000Z");

    journal.bumpStageEpoch("issue-1");
    expect(() => journal.saveCursor(cursor, 0)).toThrow(StaleEpochError);
    expect(() => journal.clearCursor("issue-1", 0)).toThrow(StaleEpochError);
    expect(journal.getCursor("issue-1")).not.toBeNull();
    journal.clearCursor("issue-1", 1);
    expect(journal.getCursor("issue-1")).toBeNull();
    expect(journal.wakeAt("issue-1")).toBeNull();
    store.close();
  });

  test("lists issues whose wake-up is due", async () => {
    const { store, journal } = await setup();
    journal.saveCursor({ ...cursor, state: "pending", wakeAt: "2026-03-01T00:00:00.000Z" }, 0);
    expect(journal.listDueWakeups(new Date("2026-02-28T23:59:59.000Z"))).toEqual([]);
    expect(journal.listDueWakeups(new Date("2026-03-01T00:00:00.000Z"))).toEqual(["issue-1"]);
    journal.saveCursor({ ...cursor, wakeAt: null }, 0);
    expect(journal.listDueWakeups(new Date("2030-01-01T00:00:00.000Z"))).toEqual([]);
    store.close();
  });
});

describe("migration", () => {
  test("applies on an existing database and keeps its data", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-journal-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "old.sqlite");
    const old = new Database(file, { create: true });
    old.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const migration of migrations.filter((m) => m.version <= 5)) {
      old.exec(migration.sql);
      old.query("INSERT INTO schema_migrations VALUES (?, 'x')").run(migration.version);
    }
    old.close();

    const store = await ConveyorStore.open(file);
    expect(store.schemaVersion()).toBe(migrations.at(-1)!.version);
    expect(migrations.at(-1)!.version).toBe(16);
    seed(store);
    const journal = new ExecutionStore(store.sqlite());
    expect(journal.bumpStageEpoch("issue-1")).toBe(1);
    store.close();
  });
});
