import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { WaitDispatcher } from "../../src/app/wait-dispatcher";
import { waitEventListenerContext } from "../../src/app/wait-listener";
import { GitHubEventListener, LISTEN_EVENTS, type ListenerBackoff } from "../../src/plugins/github/shared/event-listener";
import { ConveyorStore } from "../../src/db/store";
import { ciTopic, changeTopic } from "../../src/events/topics";
import { ConsoleSink, log, type LogRecord } from "../../src/log/logger";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const FUTURE = () => new Date(Date.now() + 5 * 60_000).toISOString();
const FAST: Partial<ListenerBackoff> = { baseMs: 20, capMs: 80, stableMs: 10_000 };

const directories: string[] = [];
const stores: ConveyorStore[] = [];
const listeners: GitHubEventListener[] = [];
let records: LogRecord[] = [];

afterEach(async () => {
  for (const listener of listeners.splice(0)) listener.close();
  for (const store of stores.splice(0)) store.close();
  log.configure({ sinks: [new ConsoleSink()] });
  records = [];
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// The documented shape of `gh event listen` output: one CloudEvent per line (see src/plugins/github/shared/event-listener.ts).
const suite = (repository: string, sha: string, conclusion: string | null) => JSON.stringify({
  specversion: "1.0", id: "e1", type: "com.github.pull_request.check_suite.status.changed.v1",
  data: { api_url: `https://api.github.com/repos/${repository}/check-suites/9`, head_sha: sha, conclusion },
});
const pullRequestEvent = (kind: string, repository: string, number: number) => JSON.stringify({
  specversion: "1.0", id: "e2", type: `com.github.pull_request.${kind}.v1`,
  data: { api_url: `https://api.github.com/repos/${repository}/pulls/${number}` },
});

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}
const quiet = (ms = 250) => Bun.sleep(ms);

async function world() {
  const dir = await mkdtemp(path.join(tmpdir(), "conveyor-listener-"));
  directories.push(dir);
  const store = await ConveyorStore.open(path.join(dir, "db.sqlite"));
  stores.push(store);
  store.recordConfigSnapshot("hash", {});
  for (const [id, address] of [["app", "Owner/App"], ["other", "Owner/Other"]] as const) {
    store.upsertRepository({ id, configName: id, source: "github", address, folder: `/srv/${id}`, configHash: "hash" });
  }
  const journal = store.executions();
  let issues = 0;
  const wakes: string[] = [];
  const dispatcher = new WaitDispatcher({
    journal,
    addressOf: () => null,
    numberOf: () => null,
    wake: (issueId) => { wakes.push(issueId); journal.wakeNow(issueId); },
  });
  log.configure({ sinks: [{ write: (record) => { records.push(record); } }] });

  /** A fake `gh`: records `pid epoch-ns args` per spawn, then runs `body`. */
  async function fakeGh(body: string, name = "gh"): Promise<string> {
    const file = path.join(dir, name);
    await writeFile(file, `#!/bin/sh\necho "$$ $(date +%s%N) $*" >> "${dir}/spawns"\n${body}\n`);
    await chmod(file, 0o755);
    return file;
  }
  const spawns = async () => (existsSync(path.join(dir, "spawns")) ? (await readFile(path.join(dir, "spawns"), "utf8")).trim().split("\n").filter(Boolean) : []);
  const spawnPids = async () => (await spawns()).map((line) => Number(line.split(" ")[0]));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  /** Writes the lines a fake gh prints (via `cat`). */
  const lines = async (...text: string[]) => { await writeFile(path.join(dir, "lines"), text.map((line) => `${line}\n`).join("")); };

  function park(repositoryId: string, number: number, topics: string[], kind: "ci" | "change" = "ci", wakeAt = FUTURE()) {
    const id = `issue-${++issues}`;
    store.upsertIssue({
      id, repositoryId, sourceNumber: number, sourceUrl: "https://example.com/1", title: "T", body: "B",
      sourceState: "open", labels: [], sourceUpdatedAt: "2026-01-01T00:00:00.000Z",
    });
    const epoch = journal.stageEpoch(id);
    const { record } = journal.planExecution({ itemId: id, stage: "review", stageEpoch: epoch, attempt: 1, list: "exit-gate", taskInstanceId: "gate" });
    journal.markPending(record.id, { wakeAt, deadlineAt: null, waitFor: { topics, kind } }, epoch);
    journal.saveCursor({ issueId: id, stage: "review", stageEpoch: epoch, attempt: 1, returns: 0, list: "exit-gate", taskInstanceId: "gate", state: "pending", feedback: null, pendingSince: null, wakeAt, deadlineAt: null }, epoch);
    return { id, epoch, wakeAt };
  }
  const end = (issue: { id: string; epoch: number }) => journal.clearCursor(issue.id, issue.epoch);
  const wakeAt = (id: string) => journal.getCursor(id)!.wakeAt;
  const wokenEvents = (id: string) => (store.sqlite().query("SELECT COUNT(*) AS n FROM events WHERE type = 'task.woken' AND issue_id = ?").get(id) as { n: number }).n;

  /** The cache drops the listener asks for, in order. */
  const forgotten: string[] = [];
  const cache = { forgetChange: (address: string, number: number) => { forgotten.push(`change ${address} ${number}`); }, forgetRepository: (address: string) => { forgotten.push(`repository ${address}`); } };

  function listener(command: string, backoff: Partial<ListenerBackoff> = FAST) {
    const instance = new GitHubEventListener({
      ...waitEventListenerContext({ journal, addresses: () => ["Owner/App", "Owner/Other"], dispatcher }),
      cache,
      command,
      backoff,
    });
    instance.start();
    listeners.push(instance);
    return instance;
  }
  const warnings = () => records.filter((record) => record.level === "warn");
  return { dir, store, journal, fakeGh, spawns, spawnPids, alive, lines, park, end, wakeAt, wokenEvents, listener, wakes, warnings, forgotten, cache, dispatcher };
}

const HOLD = "exec sleep 60";
const emit = (dir: string) => `cat "${dir}/lines"; ${HOLD}`;

describe("listener lifecycle", () => {
  test("AC-1.1 one process per repository with a pending wait, not one per sync or wait", async () => {
    const w = await world();
    w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    w.park("app", 5, [changeTopic("Owner/App", 5)], "change");
    const gh = await w.fakeGh(HOLD);
    const listener = w.listener(gh);
    listener.sync();
    listener.sync();
    await until(async () => (await w.spawns()).length === 1);
    await quiet();
    const spawned = await w.spawns();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toContain("event listen");
    expect(spawned[0]).toContain("Owner/App");
    expect(spawned[0]).toContain(LISTEN_EVENTS[0]);
    expect(listener.active).toEqual(["owner/app"]);
  });

  test("AC-1.2 the subscription stops with the last wait and is kept while another is pending", async () => {
    const w = await world();
    const a = w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    const b = w.park("app", 5, [changeTopic("Owner/App", 5)], "change");
    const listener = w.listener(await w.fakeGh(HOLD));
    await until(async () => (await w.spawns()).length === 1);
    const [pid] = await w.spawnPids();
    w.end(a);
    listener.sync();
    await quiet();
    expect(w.alive(pid!)).toBe(true);
    expect(await w.spawns()).toHaveLength(1);
    w.end(b);
    listener.sync();
    await until(() => !w.alive(pid!));
    await quiet();
    expect(await w.spawns()).toHaveLength(1);
    expect(listener.active).toEqual([]);
  });

  test("AC-1.3 repositories are independent", async () => {
    const w = await world();
    w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    const listener = w.listener(await w.fakeGh(HOLD));
    await until(async () => (await w.spawns()).length === 1);
    await quiet();
    expect((await w.spawns())[0]).toContain("Owner/App");
    expect(await w.spawns()).toHaveLength(1);
    w.park("other", 2, [ciTopic("Owner/Other", SHA)]);
    listener.sync();
    await until(async () => (await w.spawns()).length === 2);
    expect((await w.spawns())[1]).toContain("Owner/Other");
    expect(listener.active).toEqual(["owner/app", "owner/other"]);
  });

  test("AC-1.4 a stale epoch or an item that is not pending keeps no subscription", async () => {
    const w = await world();
    const running = w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    w.store.sqlite().query("UPDATE stage_cursors SET state = 'running' WHERE issue_id = ?").run(running.id);
    const stale = w.park("app", 2, [ciTopic("Owner/App", OTHER_SHA)]);
    w.store.sqlite().query("UPDATE wait_subscriptions SET stage_epoch = ? WHERE issue_id = ?").run(stale.epoch + 1, stale.id);
    const listener = w.listener(await w.fakeGh(HOLD));
    listener.sync();
    await quiet();
    expect(await w.spawns()).toHaveLength(0);
    expect(listener.active).toEqual([]);
    // A subscription that was valid is stopped once its item is no longer pending.
    const live = w.park("other", 3, [ciTopic("Owner/Other", SHA)]);
    listener.sync();
    await until(async () => (await w.spawns()).length === 1);
    const [pid] = await w.spawnPids();
    w.store.sqlite().query("UPDATE stage_cursors SET state = 'running' WHERE issue_id = ?").run(live.id);
    listener.sync();
    await until(() => !w.alive(pid!));
  });
});

describe("wakes", () => {
  test("AC-2.1 a completed check suite wakes the CI wait of its head at once", async () => {
    const w = await world();
    const item = w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    await w.lines(suite("Owner/App", SHA, "success"));
    const started = Date.now();
    w.listener(await w.fakeGh(emit(w.dir)));
    await until(() => w.wakes.length === 1);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(Date.parse(w.wakeAt(item.id)!)).toBeLessThanOrEqual(Date.now());
    expect(w.wokenEvents(item.id)).toBe(1);
  });

  test("AC-2.2 a check suite that has not completed wakes nothing", async () => {
    const w = await world();
    const item = w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    await w.lines(suite("Owner/App", SHA, null), suite("Owner/App", SHA, ""), JSON.stringify({
      type: "com.github.pull_request.check_suite.status.changed.v1",
      data: { api_url: "https://api.github.com/repos/Owner/App/check-suites/9", head_sha: SHA },
    }));
    w.listener(await w.fakeGh(emit(w.dir)));
    await quiet(400);
    expect(w.wakeAt(item.id)).toBe(item.wakeAt);
    expect(w.wokenEvents(item.id)).toBe(0);
  });

  test("AC-2.3 a completion for another head wakes only that head's wait", async () => {
    const w = await world();
    const s = w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    const t = w.park("app", 2, [ciTopic("Owner/App", OTHER_SHA)]);
    await w.lines(suite("Owner/App", OTHER_SHA, "success"));
    w.listener(await w.fakeGh(emit(w.dir)));
    await until(() => w.wakes.length === 1);
    await quiet();
    expect(w.wakes).toEqual([t.id]);
    expect(w.wakeAt(s.id)).toBe(s.wakeAt);
  });

  test("AC-2.4 the repository matches case-insensitively", async () => {
    const w = await world();
    const item = w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    expect(ciTopic("Owner/App", SHA)).toBe(`ci:owner/app:${SHA}`);
    await w.lines(suite("OWNER/app", SHA, "failure"));
    w.listener(await w.fakeGh(emit(w.dir)));
    await until(() => w.wakes.includes(item.id));
  });

  async function prWake(kind: string): Promise<void> {
    const w = await world();
    const item = w.park("app", 5, [changeTopic("Owner/App", 5)], "change");
    await w.lines(pullRequestEvent(kind, "Owner/App", 5));
    const started = Date.now();
    w.listener(await w.fakeGh(emit(w.dir)));
    await until(() => w.wakes.length === 1);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(w.wakes).toEqual([item.id]);
    expect(Date.parse(w.wakeAt(item.id)!)).toBeLessThanOrEqual(Date.now());
    expect(w.wokenEvents(item.id)).toBe(1);
  }

  test("AC-3.1 a pull request review event wakes the change wait", () => prWake("review.submitted"));
  test("AC-3.2 a pull request merge conflict event wakes the change wait", () => prWake("merge_conflict.changed"));
  test("AC-3.3 a pull request head change event wakes the change wait", () => prWake("head.changed"));

  test("AC-3.4 an event for another pull request wakes only that one", async () => {
    const w = await world();
    const a = w.park("app", 5, [changeTopic("Owner/App", 5)], "change");
    const b = w.park("app", 6, [changeTopic("Owner/App", 6)], "change");
    await w.lines(pullRequestEvent("review.submitted", "Owner/App", 6));
    w.listener(await w.fakeGh(emit(w.dir)));
    await until(() => w.wakes.length === 1);
    await quiet();
    expect(w.wakes).toEqual([b.id]);
    expect(w.wakeAt(a.id)).toBe(a.wakeAt);
  });

  test("AC-3.5 each event wakes the kind of wait it concerns", async () => {
    const w = await world();
    const c = w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    const d = w.park("app", 5, [changeTopic("Owner/App", 5)], "change");
    await w.lines(pullRequestEvent("review.submitted", "Owner/App", 5));
    const gh = await w.fakeGh(emit(w.dir));
    w.listener(gh);
    await until(() => w.wakes.length === 1);
    await quiet();
    expect(w.wakes).toEqual([d.id]);
    expect(w.wakeAt(c.id)).toBe(c.wakeAt);
  });

  test("AC-3.5 a check suite completion wakes the CI wait only", async () => {
    const w = await world();
    const c = w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    const d = w.park("app", 5, [changeTopic("Owner/App", 5)], "change");
    await w.lines(suite("Owner/App", SHA, "success"));
    w.listener(await w.fakeGh(emit(w.dir)));
    await until(() => w.wakes.length === 1);
    await quiet();
    expect(w.wakes).toEqual([c.id]);
    expect(w.wakeAt(d.id)).toBe(d.wakeAt);
  });
});

describe("events that wake nothing", () => {
  test("AC-4.1 an event without a pending wait is ignored and starts nothing", async () => {
    const w = await world();
    const item = w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    await w.lines(pullRequestEvent("review.submitted", "Owner/App", 99), suite("Owner/App", OTHER_SHA, "success"), pullRequestEvent("head.changed", "Owner/App", 99));
    const listener = w.listener(await w.fakeGh(emit(w.dir)));
    await quiet(500);
    expect(w.wakes).toEqual([]);
    expect(w.wokenEvents(item.id)).toBe(0);
    expect(w.wakeAt(item.id)).toBe(item.wakeAt);
    expect((w.store.sqlite().query("SELECT COUNT(*) AS n FROM task_executions WHERE state = 'running'").get() as { n: number }).n).toBe(0);
    expect(listener.active).toEqual(["owner/app"]);
    expect(w.warnings()).toEqual([]);
  });

  test("AC-4.2 a stale subscription or a running item wakes nothing", async () => {
    const w = await world();
    const live = w.park("app", 1, [ciTopic("Owner/App", OTHER_SHA)]);
    const stale = w.park("app", 2, [ciTopic("Owner/App", SHA)]);
    w.store.sqlite().query("UPDATE wait_subscriptions SET stage_epoch = ? WHERE issue_id = ?").run(stale.epoch + 1, stale.id);
    const running = w.park("app", 3, [ciTopic("Owner/App", SHA)]);
    w.store.sqlite().query("UPDATE stage_cursors SET state = 'running' WHERE issue_id = ?").run(running.id);
    await w.lines(suite("Owner/App", SHA, "success"));
    w.listener(await w.fakeGh(emit(w.dir)));
    await quiet(500);
    expect(w.wakes).toEqual([]);
    expect(w.wokenEvents(stale.id) + w.wokenEvents(running.id)).toBe(0);
    expect(w.wakeAt(live.id)).toBe(live.wakeAt);
  });

  test("AC-4.3 an event of another repository is ignored", async () => {
    const w = await world();
    const app = w.park("app", 1, [ciTopic("Owner/App", OTHER_SHA)]);
    const other = w.park("other", 1, [ciTopic("Owner/Other", SHA)]);
    await w.lines(suite("Owner/Other", SHA, "success"));
    const gh = await w.fakeGh(emit(w.dir));
    // A listener for the app repository only: the config lists just that repository.
    const instance = new GitHubEventListener({
      ...waitEventListenerContext({ journal: w.journal, addresses: () => ["Owner/App"], dispatcher: new WaitDispatcher({ journal: w.journal, addressOf: () => null, numberOf: () => null, wake: (id) => { w.wakes.push(id); } }) }),
      cache: w.cache, command: gh, backoff: FAST,
    });
    listeners.push(instance);
    instance.start();
    await quiet(500);
    expect(w.wakes).toEqual([]);
    expect(w.wakeAt(other.id)).toBe(other.wakeAt);
    expect(w.wakeAt(app.id)).toBe(app.wakeAt);
  });
});

describe("what the listener prints", () => {
  test("AC-5.1 a malformed line is logged and skipped, and a later event still wakes", async () => {
    const w = await world();
    const item = w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    await w.lines("{not json", suite("Owner/App", SHA, "success"));
    w.listener(await w.fakeGh(emit(w.dir)));
    await until(() => w.wakes.includes(item.id));
    const bad = w.warnings().filter((record) => record.message.includes("not JSON"));
    expect(bad).toHaveLength(1);
    expect(bad[0]!.line).toBe("{not json");
    expect(await w.spawns()).toHaveLength(1);
  });

  test("AC-5.2 JSON of the wrong shape is skipped", async () => {
    const w = await world();
    const item = w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    await w.lines("null", "[]", "{}", "42", '"text"', JSON.stringify({ type: "com.example.other.v1", data: {} }), JSON.stringify({ type: "com.github.pull_request.review.submitted.v1", data: {} }), "", suite("Owner/App", SHA, "success"));
    w.listener(await w.fakeGh(emit(w.dir)));
    await until(() => w.wakes.includes(item.id));
    expect(w.wakes).toEqual([item.id]);
    expect(await w.spawns()).toHaveLength(1);
    expect(w.warnings()).toEqual([]);
  });

  test("AC-5.3 a split line is reassembled and a truncated tail is not handled", async () => {
    const w = await world();
    const item = w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    const line = suite("Owner/App", SHA, "success");
    const cut = Math.floor(line.length / 2);
    const gh = await w.fakeGh(`printf '%s' '${line.slice(0, cut)}'; sleep 0.2; printf '%s\\n' '${line.slice(cut)}'; printf '%s' '${line.slice(0, cut)}'`);
    w.listener(gh, { baseMs: 60_000, capMs: 60_000, stableMs: 10_000 });
    await until(() => w.warnings().some((record) => record.message.includes("not JSON")));
    expect(w.wakes).toEqual([item.id]);
    expect(w.wokenEvents(item.id)).toBe(1);
  });
});

describe("gh unavailable or failing", () => {
  test("AC-6.1 a missing gh logs once and leaves the poll alone", async () => {
    const w = await world();
    const item = w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    const listener = w.listener(path.join(w.dir, "no-such-gh"), { baseMs: 60_000, capMs: 60_000, stableMs: 10_000 });
    for (let i = 0; i < 4; i++) { listener.sync(); await quiet(30); }
    expect(w.warnings()).toHaveLength(1);
    expect(w.wakeAt(item.id)).toBe(item.wakeAt);
  });

  test("AC-6.2 a gh too old for `event` logs the cause once; the item is still due at its wake_at", async () => {
    const w = await world();
    const item = w.park("app", 1, [ciTopic("Owner/App", SHA)], "ci", new Date(Date.now() + 300).toISOString());
    w.listener(await w.fakeGh(`echo 'unknown command "event" for "gh"' >&2; exit 1`), { baseMs: 60_000, capMs: 60_000, stableMs: 10_000 });
    await until(() => w.warnings().length === 1);
    expect(w.warnings()[0]!.cause).toContain('unknown command "event"');
    expect(w.wakeAt(item.id)).toBe(item.wakeAt);
    await until(() => (w.store.sqlite().query("SELECT issue_id FROM stage_cursors WHERE wake_at <= ?").all(new Date().toISOString()) as Array<{ issue_id: string }>).some((row) => row.issue_id === item.id));
  });

  test("AC-6.3 an unauthenticated gh logs once", async () => {
    const w = await world();
    const item = w.park("app", 5, [changeTopic("Owner/App", 5)], "change");
    w.listener(await w.fakeGh(`echo 'To get started with GitHub CLI, please run: gh auth login' >&2; exit 4`), { baseMs: 60_000, capMs: 60_000, stableMs: 10_000 });
    await until(() => w.warnings().length === 1);
    await quiet();
    expect(w.warnings()).toHaveLength(1);
    expect(w.warnings()[0]!.exitCode).toBe(4);
    expect(w.warnings()[0]!.cause).toContain("gh auth login");
    expect(w.wakeAt(item.id)).toBe(item.wakeAt);
  });

  test("AC-6.4 an unexpected exit logs one warning and does not touch the poll wake", async () => {
    const w = await world();
    const item = w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    w.listener(await w.fakeGh("sleep 0.1; exit 1"), { baseMs: 60_000, capMs: 60_000, stableMs: 10_000 });
    await until(() => w.warnings().length === 1);
    await quiet();
    expect(w.warnings()).toHaveLength(1);
    expect(w.wakeAt(item.id)).toBe(item.wakeAt);
    expect(w.wakes).toEqual([]);
  });

  test("AC-6.5 one warning per failure, none duplicated", async () => {
    const w = await world();
    w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    w.listener(await w.fakeGh("exit 1"), { baseMs: 20, capMs: 20, stableMs: 10_000 });
    await until(async () => (await w.spawns()).length >= 3);
    const listener = listeners[0]!;
    // Stop at exactly the third failure: closing keeps further exits out of the count.
    await until(() => w.warnings().length >= 3);
    listener.close();
    const spawned = (await w.spawns()).length;
    await quiet(100);
    expect(w.warnings().length).toBeGreaterThanOrEqual(3);
    // Each failure was reported once: warnings never exceed the spawns that failed.
    expect(w.warnings().length).toBeLessThanOrEqual(spawned);
    expect(await w.spawns()).toHaveLength(spawned);
  });
});

describe("restart", () => {
  test("AC-7.1 an unexpected exit is followed by a restart that can wake", async () => {
    const w = await world();
    const item = w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    await w.lines(suite("Owner/App", SHA, "success"));
    const gh = await w.fakeGh(`if [ "$(wc -l < "${w.dir}/spawns")" -le 1 ]; then exit 1; fi\n${emit(w.dir)}`);
    w.listener(gh);
    await until(() => w.wakes.includes(item.id));
    expect(await w.spawns()).toHaveLength(2);
    const pids = await w.spawnPids();
    expect(w.alive(pids[1]!)).toBe(true);
  });

  test("AC-7.2 the delay grows to the cap and returns to the base after a healthy run", async () => {
    const w = await world();
    w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    const stable = 150;
    // The sixth run stays up past the stable threshold; the others exit at once.
    const gh = await w.fakeGh(`if [ "$(wc -l < "${w.dir}/spawns")" -eq 6 ]; then sleep 0.3; fi\nexit 1`);
    w.listener(gh, { baseMs: 20, capMs: 80, stableMs: stable });
    await until(async () => (await w.spawns()).length >= 8);
    const times = (await w.spawns()).map((line) => Number(line.split(" ")[1]) / 1e6);
    const gaps = times.slice(1).map((time, index) => time - times[index]!);
    // 20, 40, 80, 80 (+ process start); then the healthy sixth run, then the base delay again.
    expect(gaps[1]!).toBeGreaterThan(gaps[0]! - 5);
    expect(gaps[2]!).toBeGreaterThan(gaps[1]! - 5);
    for (const gap of gaps.slice(0, 4)) expect(gap).toBeLessThan(80 + 150);
    expect(gaps[3]!).toBeGreaterThan(70);
    expect(gaps[6]!).toBeLessThan(gaps[3]!);
  });

  test("AC-7.3 no restart once the wait ended, and the timer is cancelled", async () => {
    const w = await world();
    const item = w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    const listener = w.listener(await w.fakeGh("exit 1"), { baseMs: 300, capMs: 300, stableMs: 10_000 });
    await until(() => w.warnings().length === 1);
    w.end(item);
    listener.sync();
    await quiet(600);
    expect(await w.spawns()).toHaveLength(1);
    expect(w.warnings()).toHaveLength(1);
    expect(listener.active).toEqual([]);
  });

  test("AC-7.4 a deliberate stop is neither a warning nor a restart", async () => {
    const w = await world();
    const item = w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    const listener = w.listener(await w.fakeGh(HOLD));
    await until(async () => (await w.spawns()).length === 1);
    const [pid] = await w.spawnPids();
    w.end(item);
    listener.sync();
    await until(() => !w.alive(pid!));
    const second = w.park("app", 2, [ciTopic("Owner/App", SHA)]);
    listener.sync();
    await until(async () => (await w.spawns()).length === 2);
    const pids = await w.spawnPids();
    listener.close();
    await until(() => !w.alive(pids[1]!));
    w.end(second);
    await quiet(300);
    expect(await w.spawns()).toHaveLength(2);
    expect(w.warnings()).toEqual([]);
  });
});

describe("a wake only makes the item due", () => {
  test("AC-8.3 the payload writes nothing but the wake", async () => {
    const w = await world();
    const item = w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    const tables = ["ci_indicators", "github_read_cache", "github_mirror", "change_records"]
      .filter((name) => w.store.sqlite().query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
    const snapshot = () => tables.map((name) => JSON.stringify(w.store.sqlite().query(`SELECT * FROM ${name}`).all()));
    const before = snapshot();
    const suites = w.store.sqlite().query("SELECT type, COUNT(*) AS n FROM events GROUP BY type ORDER BY type").all();
    await w.lines(suite("Owner/App", SHA, "failure"));
    w.listener(await w.fakeGh(emit(w.dir)));
    await until(() => w.wakes.length === 1);
    expect(snapshot()).toEqual(before);
    const after = w.store.sqlite().query("SELECT type, COUNT(*) AS n FROM events GROUP BY type ORDER BY type").all() as Array<{ type: string; n: number }>;
    const changed = after.filter((row) => (suites as Array<{ type: string; n: number }>).find((old) => old.type === row.type)?.n !== row.n).map((row) => row.type);
    expect(changed).toEqual(["task.woken"]);
    expect(w.journal.getCursor(item.id)!.state).toBe("pending");
  });

  test("AC-8.4 a burst of events wakes the wait once", async () => {
    const w = await world();
    const item = w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    const line = suite("Owner/App", SHA, "success");
    await w.lines(line, line, line, line, line);
    w.listener(await w.fakeGh(emit(w.dir)));
    await until(() => w.wakes.length >= 1);
    await quiet();
    expect(w.wakes).toEqual([item.id]);
    expect(w.wokenEvents(item.id)).toBe(1);
  });
});

describe("cached reads", () => {
  test("a matching event drops the cached reads of its pull request before waking the wait", async () => {
    const w = await world();
    const issue = w.park("app", 5, [changeTopic("Owner/App", 5)], "change");
    await w.lines(pullRequestEvent("review.submitted", "Owner/App", 5));
    w.listener(await w.fakeGh(emit(w.dir)));
    await until(() => w.wakeAt(issue.id) !== issue.wakeAt);
    expect(w.forgotten).toEqual(["change Owner/App 5"]);
  });

  test("a finished check suite that names no pull request drops the repository's cached reads", async () => {
    const w = await world();
    const issue = w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    await w.lines(suite("Owner/App", SHA, "success"));
    w.listener(await w.fakeGh(emit(w.dir)));
    await until(() => w.wakeAt(issue.id) !== issue.wakeAt);
    expect(w.forgotten).toEqual(["repository Owner/App"]);
  });

  test("an event no wait is pending for drops nothing", async () => {
    const w = await world();
    w.park("app", 1, [ciTopic("Owner/App", SHA)]);
    await w.lines(pullRequestEvent("review.submitted", "Owner/App", 99), suite("Owner/App", OTHER_SHA, "success"));
    w.listener(await w.fakeGh(emit(w.dir)));
    await quiet(500);
    expect(w.forgotten).toEqual([]);
  });
});
