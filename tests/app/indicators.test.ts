import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CiRun } from "../../src/app/ci-provider";
import { deriveCiIndicator, indicatorView, observeCi, observeCiError, startCiForHead, type CiDerivationInput } from "../../src/app/indicators";
import { ConveyorStore } from "../../src/db/store";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const run = (name: string, state: CiRun["state"], over: Partial<CiRun> = {}): CiRun => ({
  id: `id-${name}`, name, state, url: `https://ci/${name}`, canRerun: false, hasLog: true, startedAt: null, completedAt: null, ...over,
});
const derive = (runs: CiRun[] | null, over: Partial<CiDerivationInput> = {}) =>
  deriveCiIndicator({ headSha: "abcdef1234", changeUrl: "https://x/pull/5", runs, ignoreChecks: [], starting: false, observedAt: "2026-01-01T00:00:00.000Z", ...over });

describe("deriveCiIndicator", () => {
  test("failed when any counted run failed, even while others run", () => {
    const indicator = derive([run("a", "failed"), run("b", "running"), run("c", "passed")]);
    expect(indicator).toMatchObject({ id: "ci", label: "CI", state: "failed", progress: "1 failed", detail: "1 failed · 1/3 passed" });
  });

  test("running when any run is queued or running", () => {
    expect(derive([run("a", "queued"), run("b", "passed")])).toMatchObject({ state: "running", progress: "1 running", detail: "1 running · 1/2 passed" });
  });

  test("passing when all counted runs passed or were skipped", () => {
    expect(derive([run("a", "passed"), run("b", "skipped")])).toMatchObject({ state: "passing", progress: "2/2", detail: "2/2 passed" });
  });

  test("ignored checks are not counted or listed", () => {
    const indicator = derive([run("a", "passed"), run("Lint", "failed")], { ignoreChecks: ["Lint"] });
    expect(indicator.state).toBe("passing");
    expect(indicator.entries.map((entry) => entry.name)).toEqual(["a"]);
  });

  test("a cancelled run that can be rerun is unfinished until its rerun mark exists, then it fails", () => {
    const cancelled = run("a", "cancelled", { canRerun: true });
    expect(derive([cancelled]).state).toBe("running");
    expect(derive([cancelled], { reruns: ["a"] }).state).toBe("failed");
    expect(derive([cancelled], { reruns: ["a"], rerunIds: ["id-a"] }).state).toBe("running");
    expect(derive([run("a", "cancelled")]).state).toBe("failed");
  });

  test("a started check that has not registered counts as running", () => {
    expect(derive([run("a", "passed")], { awaitingStart: ["Web"] })).toMatchObject({ state: "running", detail: "1 running · 1/2 passed" });
    expect(derive([run("a", "passed"), run("Web", "passed")], { awaitingStart: ["Web"] }).state).toBe("passing");
  });

  test("no runs: starting on a new head, otherwise unknown", () => {
    expect(derive([], { starting: true })).toMatchObject({ state: "running", detail: "CI is starting", progress: "starting" });
    expect(derive([])).toMatchObject({ state: "unknown", progress: "no runs" });
  });

  test("an unreadable provider is unknown with the error and no runs", () => {
    expect(derive(null, { error: "502" })).toMatchObject({ state: "unknown", detail: "CI could not be read: 502", entries: [] });
  });

  test("links to the checks and carries the short head and entry times", () => {
    const indicator = derive([run("a", "passed", { startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:01:00Z" })]);
    expect(indicator.url).toBe("https://x/pull/5/checks");
    expect(indicator.reference).toEqual({ label: "abcdef1", url: "https://x/pull/5" });
    expect(indicator.entries[0]).toEqual({ name: "a", state: "passed", url: "https://ci/a", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:01:00Z" });
  });
});

describe("indicatorView", () => {
  test("durations are measured, live for a running run, and unavailable without a provider time", () => {
    const view = indicatorView(derive([
      run("done", "passed", { startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:01:30Z" }),
      run("live", "running", { startedAt: "2026-01-01T00:00:00Z" }),
      run("queued", "queued"),
      run("odd", "passed", { startedAt: "2026-01-01T00:00:00Z" }),
    ]), Date.parse("2026-01-01T00:05:00Z"));
    const by = Object.fromEntries(view.entries.map((entry) => [entry.name, entry]));
    expect(by.done).toMatchObject({ durationMs: 90_000, live: false });
    expect(by.live).toMatchObject({ durationMs: 300_000, live: true });
    expect(by.queued).toMatchObject({ startedAt: null, durationMs: null });
    expect(by.odd).toMatchObject({ durationMs: null });
    expect(view).toMatchObject({ symbol: "●", stateWord: "running" });
  });
});

async function open() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-indicators-"));
  directories.push(root);
  const file = path.join(root, "db.sqlite");
  const store = await ConveyorStore.open(file);
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "o/r", folder: "/f", configHash: "h" });
  store.upsertIssue({ id: "i1", repositoryId: "repo", sourceNumber: 7, sourceUrl: "u", title: "T", body: "", sourceState: "open", labels: [], sourceUpdatedAt: "2026-01-01T00:00:00Z" });
  return { store, file };
}
const input = (over: Partial<Parameters<typeof observeCi>[1]> = {}) => ({
  issueId: "i1", headSha: "head1", changeUrl: "https://x/pull/5", runs: [run("a", "running")], ignoreChecks: [],
  now: new Date("2026-01-01T00:10:00Z"), authoritative: true, ...over,
});

describe("stored indicators", () => {
  test("survive a restart with their entries", async () => {
    const { store, file } = await open();
    observeCi(store, input());
    store.close();
    const reopened = await ConveyorStore.open(file);
    const [stored] = reopened.listIndicators("i1");
    expect(stored).toMatchObject({ id: "ci", headSha: "head1", state: "running", observedAt: "2026-01-01T00:10:00.000Z" });
    expect(stored!.entries.map((entry) => entry.name)).toEqual(["a"]);
    reopened.close();
  });

  test("a new head replaces the old runs at once with a starting indicator", async () => {
    const { store } = await open();
    observeCi(store, input({ runs: [run("a", "failed")] }));
    expect(startCiForHead(store, { issueId: "i1", headSha: "head2", changeUrl: "https://x/pull/5", now: new Date("2026-01-01T00:11:00Z") })).toBe(true);
    const [stored] = store.listIndicators("i1");
    expect(stored).toMatchObject({ headSha: "head2", state: "running", detail: "CI is starting", entries: [] });
    store.close();
  });

  test("late observations of an older head cannot replace the current indicator", async () => {
    const { store } = await open();
    startCiForHead(store, { issueId: "i1", headSha: "head2", changeUrl: "https://x/pull/5", now: new Date("2026-01-01T00:11:00Z") });
    expect(observeCi(store, input({ headSha: "head1", authoritative: false, runs: [run("a", "passed")] }))).toBe(false);
    expect(observeCiError(store, { ...input({ headSha: "head1", authoritative: false }), error: new Error("x") })).toBe(false);
    expect(store.listIndicators("i1")[0]).toMatchObject({ headSha: "head2", state: "running" });
    store.close();
  });

  test("after the starting period an empty head becomes unknown; an error never keeps a stale state", async () => {
    const { store } = await open();
    startCiForHead(store, { issueId: "i1", headSha: "head1", changeUrl: "https://x/pull/5", now: new Date("2026-01-01T00:10:00Z") });
    observeCi(store, input({ runs: [], now: new Date("2026-01-01T00:11:00Z") }));
    expect(store.listIndicators("i1")[0]).toMatchObject({ state: "running", detail: "CI is starting" });
    observeCi(store, input({ runs: [], now: new Date("2026-01-01T00:13:00Z") }));
    expect(store.listIndicators("i1")[0]).toMatchObject({ state: "unknown" });
    observeCi(store, input({ runs: [run("a", "passed")], now: new Date("2026-01-01T00:14:00Z") }));
    observeCiError(store, { ...input({ now: new Date("2026-01-01T00:15:00Z") }), error: new Error("boom") });
    expect(store.listIndicators("i1")[0]).toMatchObject({ state: "unknown", detail: "CI could not be read: boom", entries: [] });
    store.close();
  });

  test("the dashboard revision moves when the shown status changes, not on a repeated observation", async () => {
    const { store } = await open();
    observeCi(store, input());
    const first = store.dashboardRevision();
    await Bun.sleep(3);
    observeCi(store, input({ now: new Date("2026-01-01T00:20:00Z") }));
    expect(store.dashboardRevision()).toBe(first);
    expect(store.listIndicators("i1")[0]!.observedAt).toBe("2026-01-01T00:20:00.000Z");
    await Bun.sleep(3);
    observeCi(store, input({ runs: [run("a", "passed")] }));
    expect(store.dashboardRevision()).not.toBe(first);
    store.close();
  });

  test("indicators are removed with their item and can be cleared", async () => {
    const { store } = await open();
    observeCi(store, input());
    store.clearIndicator("i1", "ci");
    expect(store.listIndicators()).toEqual([]);
    store.close();
  });
});
