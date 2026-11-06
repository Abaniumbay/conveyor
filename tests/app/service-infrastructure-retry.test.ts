import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { IssueExecutor } from "../../src/app/issue-executor";
import { ConveyorService } from "../../src/app/service";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore, type StoredIssue } from "../../src/db/store";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup(githubConfig = "") {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-infra-retry-"));
  directories.push(root);
  const repositoryPath = path.join(root, "repo");
  await mkdir(repositoryPath);
  await writeFile(path.join(root, "instructions.md"), "Work.");
  await writeFile(path.join(root, "config.yml"), `
settings:
  database: ${root}/db.sqlite
  logs: ${root}/logs
  workspaces: ${root}/workspaces
  artifacts: ${root}/artifacts
  retries: { infrastructureAttempts: 2, usageLimitAttempts: unlimited, minBackoff: 1s, maxBackoff: 4s }
${githubConfig}web: {}
sources: { github: { type: github } }
runners: { codex: { type: codex } }
agents: { worker: { runner: codex, instructions: ./instructions.md } }
checks: {}
labels:
  enrollment: conveyor
  stageTemplate: "conveyor:{stage}"
  states: { done: "conveyor:done", blocked: "conveyor:blocked", error: "conveyor:error", needs-intervention: "conveyor:needs-intervention" }
  metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" }
pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked, error]
    stages:
      - id: implementation
        run: { agent: worker }
        concurrency: 1
repositories:
  repo:
    source: github
    address: owner/repo
    folder: ${repositoryPath}
    pipeline: default
`);
  const config = await loadConfig(path.join(root, "config.yml"));
  const store = await ConveyorStore.open(config.settings.database);
  const labels: string[][] = [];
  const probe = { healthy: false, probes: 0 };
  const github = {
    async replaceConveyorLabels(_address: string, _number: number, next: readonly string[]) { labels.push([...next]); },
    async rateLimit() { probe.probes += 1; if (!probe.healthy) throw new Error("HTTP 503 Service Unavailable"); return { core: null, graphql: null }; },
  };
  const service = new ConveyorService(config, store, github as never);
  const internals = service as unknown as Record<string, unknown>;
  internals.updateStatusComment = async () => {};
  internals.schedule = () => {};
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: repositoryPath, configHash: config.hash });
  store.upsertIssue({
    id: "issue", repositoryId: "repo", sourceNumber: 1, sourceUrl: "https://example.test/1", title: "Feature", body: "",
    sourceState: "open", labels: ["conveyor", "conveyor:implementation"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  store.setIssueProjection("issue", { stage: "implementation", state: "active", warning: null });
  store.setStageState({ issueId: "issue", stageId: "implementation", status: "error", feedbackCycle: 0, configHash: config.hash });
  const execute = (issue: StoredIssue) =>
    (internals.execute as (i: StoredIssue, s: AbortSignal) => Promise<void>).call(service, issue, new AbortController().signal);
  return { service, store, labels, execute, internals, probe };
}

describe("infrastructure failures", () => {
  test("back off, then stop the item as error with the reason once the attempts are used up", async () => {
    const { service, store, labels, execute, internals } = await setup();
    const delays: number[] = [];
    internals.retryLater = (_issueId: string, delayMs: number) => { delays.push(delayMs); };
    const spy = spyOn(IssueExecutor.prototype, "execute").mockRejectedValue(new Error("conversation message must not exceed 4000 characters"));
    try {
      await execute(store.getIssue("issue")!);
      await execute(store.getIssue("issue")!);
      expect(delays).toEqual([1_000, 2_000]);
      expect(labels).toEqual([]);
      await execute(store.getIssue("issue")!);
      expect(delays).toEqual([1_000, 2_000]);
      expect(labels).toEqual([["conveyor", "conveyor:error", "conveyor:implementation"]]);
      const notes = store.listConversationMessages("issue").map((message) => message.message);
      expect(notes).toEqual([expect.stringContaining("stopped after 3 failed attempts")]);
      expect(notes[0]).toContain("conversation message must not exceed 4000 characters");
    } finally {
      spy.mockRestore();
      await service.close();
    }
  });

  test("a success resets the count", async () => {
    const { service, store, execute, internals } = await setup();
    const delays: number[] = [];
    internals.retryLater = (_issueId: string, delayMs: number) => { delays.push(delayMs); };
    internals.reconcileRepository = async () => {};
    const spy = spyOn(IssueExecutor.prototype, "execute").mockRejectedValueOnce(new Error("boom"));
    try {
      await execute(store.getIssue("issue")!);
      spy.mockResolvedValueOnce({ kind: "parked", stageId: "implementation", reason: "pending", wakeAt: null });
      await execute(store.getIssue("issue")!);
      spy.mockRejectedValueOnce(new Error("boom"));
      await execute(store.getIssue("issue")!);
      expect(delays).toEqual([1_000, 1_000]);
    } finally {
      spy.mockRestore();
      await service.close();
    }
  });

  const OUTAGE = "gh: HTTP 502 Bad Gateway (https://api.github.com/graphql)";

  test("a transient GitHub failure waits instead of blocking, beyond the attempts", async () => {
    const { service, store, labels, execute, internals } = await setup();
    const delays: number[] = [];
    internals.retryLater = (_issueId: string, delayMs: number) => { delays.push(delayMs); };
    const spy = spyOn(IssueExecutor.prototype, "execute").mockRejectedValue(new Error(OUTAGE));
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) await execute(store.getIssue("issue")!);
      expect(delays).toEqual([1_000, 2_000, 4_000, 4_000, 4_000]);
      expect(labels).toEqual([]);
      const outage = (service as unknown as { githubOutage(): { since: string; waitingItems: string[] } | null }).githubOutage();
      expect(outage?.waitingItems).toEqual(["issue"]);
      expect(store.getIssue("issue")?.warning).toContain("GitHub unavailable since");
    } finally {
      spy.mockRestore();
      await service.close();
    }
  });

  test("the waiting item resumes at the same stage once GitHub answers", async () => {
    const { service, store, execute, internals, probe } = await setup();
    let scheduled = 0;
    internals.schedule = () => { scheduled += 1; };
    const timers: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => { timers.push(fn); return 0 as never; }) as never;
    const spy = spyOn(IssueExecutor.prototype, "execute").mockRejectedValue(new Error(OUTAGE));
    try {
      await execute(store.getIssue("issue")!);
      store.setStageState({ issueId: "issue", stageId: "implementation", status: "error", feedbackCycle: 0, configHash: store.getStageState("issue")!.configHash });
      const wait = async () => { await timers.shift()!(); await new Promise((resolve) => realSetTimeout(resolve, 5)); };
      await wait();
      expect(probe.probes).toBe(1);
      expect(store.getStageState("issue")?.status).toBe("error");
      expect(scheduled).toBe(0);
      probe.healthy = true;
      await wait();
      expect(probe.probes).toBe(2);
      expect(store.getStageState("issue")).toMatchObject({ stageId: "implementation", status: "ready" });
      expect(scheduled).toBe(1);
      spy.mockResolvedValue({ kind: "parked", stageId: "implementation", reason: "pending", wakeAt: null });
      internals.reconcileRepository = async () => {};
      await execute(store.getIssue("issue")!);
      expect((service as unknown as { githubOutage(): unknown }).githubOutage()).toBeNull();
    } finally {
      globalThis.setTimeout = realSetTimeout;
      spy.mockRestore();
      await service.close();
    }
  });

  test("a permanent GitHub failure still stops the item as before", async () => {
    const { service, store, labels, execute, internals } = await setup();
    internals.retryLater = () => {};
    const spy = spyOn(IssueExecutor.prototype, "execute").mockRejectedValue(new Error("gh: HTTP 404 Not Found (repos/owner/repo)"));
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) await execute(store.getIssue("issue")!);
      expect(labels).toEqual([["conveyor", "conveyor:error", "conveyor:implementation"]]);
      expect((service as unknown as { githubOutage(): unknown }).githubOutage()).toBeNull();
    } finally {
      spy.mockRestore();
      await service.close();
    }
  });

  test("past github.outageWaitLimit the item needs intervention, and the reason names GitHub and the first failure time", async () => {
    const { service, store, labels, execute, internals } = await setup("github: { outageWaitLimit: 1h }\n");
    internals.retryLater = () => {};
    const spy = spyOn(IssueExecutor.prototype, "execute").mockRejectedValue(new Error(OUTAGE));
    const realNow = Date.now;
    const start = realNow();
    try {
      await execute(store.getIssue("issue")!);
      const since = new Date(start).toISOString().slice(0, 16);
      Date.now = () => start + 61 * 60_000;
      const RealDate = Date;
      globalThis.Date = class extends RealDate {
        constructor(...args: unknown[]) { super(...(args.length ? (args as [string]) : [start + 61 * 60_000])); }
      } as DateConstructor;
      try {
        await execute(store.getIssue("issue")!);
      } finally {
        globalThis.Date = RealDate;
      }
      expect(labels).toEqual([["conveyor", "conveyor:implementation", "conveyor:needs-intervention"]]);
      const [note] = store.listConversationMessages("issue").map((message) => message.message);
      expect(note).toContain("GitHub");
      expect(note).toContain(since);
      expect((service as unknown as { githubOutage(): unknown }).githubOutage()).toBeNull();
    } finally {
      Date.now = realNow;
      spy.mockRestore();
      await service.close();
    }
  });
});
