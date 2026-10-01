import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CiChange, CiProvider, CiRun } from "../../src/app/ci-provider";
import { ConveyorStore } from "../../src/db/store";
import { AdvisoryCiWatches } from "../../src/engine/advisory-ci";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const MIN = 60_000;
const ID = "issue-1";

class FakeCi implements CiProvider {
  runs: CiRun[] = [];
  logs: Record<string, string> = {};
  listed = 0;
  async start() { return []; }
  async list(_c: CiChange, _commit: string) { this.listed++; return this.runs; }
  async rerun() {}
  async definitions() { return { defined: true, provable: true, summary: "" }; }
  async log(_c: CiChange, runId: string) { return this.logs[runId] ?? ""; }
}
const run = (name: string, state: CiRun["state"]): CiRun => ({ id: `id-${name}`, name, state, url: `https://ci/${name}`, canRerun: false, hasLog: true });

async function setup(directory?: string) {
  const dir = directory ?? await mkdtemp(path.join(tmpdir(), "conveyor-advisory-"));
  if (!directory) directories.push(dir);
  const store = await ConveyorStore.open(path.join(dir, "conveyor.sqlite"));
  if (!directory) {
    store.recordConfigSnapshot("hash", {});
    store.upsertRepository({ id: "repo-1", configName: "sample", source: "github", address: "owner/sample", folder: "/srv/sample", configHash: "hash" });
    store.upsertIssue({ id: ID, repositoryId: "repo-1", sourceNumber: 1, sourceUrl: "u", title: "T", body: "B", sourceState: "open", labels: [], sourceUpdatedAt: "2026-01-01T00:00:00.000Z" });
  }
  const provider = new FakeCi();
  const posted: Array<{ itemId: string; stage: string; message: string }> = [];
  const watches = new AdvisoryCiWatches(store.sqlite(), store.executions(), {
    resolve: () => ({ provider, address: "owner/sample", ignoreChecks: [] }),
    post: (itemId, stage, message) => { posted.push({ itemId, stage, message }); },
  });
  return { dir, store, provider, posted, watches };
}

const ensure = (w: AdvisoryCiWatches, head: string, now = T0, over: Record<string, unknown> = {}) =>
  w.ensureWatch({ repositoryId: "repo-1", itemId: ID, headSha: head, stage: "implementation", change: { changeId: "5", url: "https://x/pull/5" }, now, ...over });

describe("AdvisoryCiWatches", () => {
  test("a duplicate start reuses the watch for the same head", async () => {
    const { watches } = await setup();
    const a = ensure(watches, "head1");
    const b = ensure(watches, "head1", T0 + MIN);
    expect(b.id).toBe(a.id);
    expect(b.startedAt).toBe(a.startedAt);
    expect(a.state).toBe("active");
    expect(a.deadlineAt).toBe(new Date(T0 + 3 * 60 * MIN).toISOString());
  });

  test("announces once, posts exactly one passed message after the settle window and never repeats", async () => {
    const { watches, provider, posted } = await setup();
    provider.runs = [run("build", "running")];
    ensure(watches, "head1", T0, { settleMs: 150_000 });
    await watches.pollDueWatches(T0 + MIN);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.message).toContain("CI started for head1");
    expect(posted[0]!.stage).toBe("implementation");
    // Not due yet: nothing is listed.
    const listed = provider.listed;
    await watches.pollDueWatches(T0 + MIN + 1_000);
    expect(provider.listed).toBe(listed);

    provider.runs = [run("build", "passed")];
    await watches.pollDueWatches(T0 + 2 * MIN); // inside the 150 s settle window
    expect(posted).toHaveLength(1);
    await watches.pollDueWatches(T0 + 3 * MIN);
    expect(posted).toHaveLength(2);
    expect(posted[1]!.message).toContain("CI passed");
    expect(posted[1]!.message).toContain("https://ci/build");
    expect(watches.get(ID, "head1")!.state).toBe("passed");
    await watches.pollDueWatches(T0 + 10 * MIN);
    await watches.pollDueWatches(T0 + 20 * MIN);
    expect(posted).toHaveLength(2);
  });

  test("a failure posts one message with focused logs", async () => {
    const { watches, provider, posted } = await setup();
    provider.runs = [run("build", "failed"), run("lint", "passed")];
    provider.logs["id-build"] = "boom: expected 1 got 2";
    ensure(watches, "head1");
    await watches.pollDueWatches(T0 + 3 * MIN);
    const final = posted.at(-1)!.message;
    expect(final).toContain("CI failed");
    expect(final).toContain("build (failed)");
    expect(final).toContain("boom: expected 1 got 2");
    expect(watches.get(ID, "head1")!.state).toBe("failed");
  });

  test("a restart with the same database keeps the watch and posts the final message exactly once", async () => {
    const first = await setup();
    first.provider.runs = [run("build", "running")];
    ensure(first.watches, "head1");
    await first.watches.pollDueWatches(T0 + MIN);
    expect(first.posted).toHaveLength(1);
    first.store.close();

    const second = await setup(first.dir);
    second.provider.runs = [run("build", "passed")];
    await second.watches.pollDueWatches(T0 + 3 * MIN);
    expect(second.posted.map((p) => p.message.split("\n")[0])).toEqual([expect.stringContaining("CI passed")]);
    second.store.close();

    const third = await setup(first.dir);
    third.provider.runs = [run("build", "passed")];
    await third.watches.pollDueWatches(T0 + 9 * MIN);
    expect(third.posted).toHaveLength(0);
    expect(third.watches.get(ID, "head1")!.finalMessageAt).not.toBeNull();
  });

  test("a new head supersedes older active watches, whose final message is suppressed", async () => {
    const { watches, provider, posted } = await setup();
    provider.runs = [run("build", "passed")];
    ensure(watches, "head1");
    ensure(watches, "head2", T0 + MIN);
    expect(watches.get(ID, "head1")!.state).toBe("superseded");
    await watches.pollDueWatches(T0 + 5 * MIN);
    const messages = posted.map((p) => p.message);
    expect(messages.filter((m) => m.includes("head1") || m.includes("CI passed at head1"))).toHaveLength(0);
    expect(messages.some((m) => m.includes("CI passed at head2"))).toBe(true);
    expect(watches.get(ID, "head1")!.finalMessageAt).toBeNull();
  });

  test("past the deadline one timeout message is posted", async () => {
    const { watches, provider, posted } = await setup();
    provider.runs = [run("build", "running")];
    ensure(watches, "head1", T0, { timeoutMs: 10 * MIN });
    await watches.pollDueWatches(T0 + 5 * MIN);
    await watches.pollDueWatches(T0 + 11 * MIN);
    await watches.pollDueWatches(T0 + 30 * MIN);
    const finals = posted.filter((p) => p.message.includes("did not finish"));
    expect(finals).toHaveLength(1);
    expect(watches.get(ID, "head1")!.state).toBe("timed-out");
  });

  test("an already announced head is not announced again by the watch", async () => {
    const { watches, provider, posted, store } = await setup();
    store.executions().markCi(ID, "head1", "announced", "", new Date(T0).toISOString());
    provider.runs = [run("build", "running")];
    ensure(watches, "head1");
    await watches.pollDueWatches(T0 + MIN);
    expect(posted).toHaveLength(0);
  });

  test("nextWakeAt reports the earliest active wake-up and ignores finished watches", async () => {
    const { watches, provider } = await setup();
    expect(watches.nextWakeAt()).toBeNull();
    ensure(watches, "head1");
    expect(watches.nextWakeAt()).toBe(new Date(T0 + MIN).toISOString());
    provider.runs = [run("build", "failed")];
    await watches.pollDueWatches(T0 + 3 * MIN);
    expect(watches.nextWakeAt()).toBeNull();
  });

  test("an unreadable provider before the deadline retries; past it one timeout message is posted", async () => {
    const { watches, provider, posted } = await setup();
    provider.list = async () => { throw new Error("api down"); };
    ensure(watches, "head1", T0, { timeoutMs: 10 * MIN });
    await watches.pollDueWatches(T0 + 2 * MIN);
    expect(posted).toHaveLength(0);
    expect(watches.get(ID, "head1")!.state).toBe("active");
    await watches.pollDueWatches(T0 + 11 * MIN);
    await watches.pollDueWatches(T0 + 30 * MIN);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.message).toContain("could not be read");
    expect(posted[0]!.message).toContain("api down");
    expect(watches.get(ID, "head1")!.state).toBe("timed-out");
  });

  test("an overlapping pollDueWatches call is a no-op", async () => {
    const { watches, provider, posted } = await setup();
    provider.runs = [run("build", "running")];
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    provider.list = async () => { provider.listed++; await gate; return provider.runs; };
    ensure(watches, "head1");
    const first = watches.pollDueWatches(T0 + MIN);
    await watches.pollDueWatches(T0 + MIN);
    expect(provider.listed).toBe(1);
    release();
    await first;
    expect(posted).toHaveLength(1);
  });
});
