import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { ConsoleSink, log, type LogRecord } from "../../src/log/logger";
import type { GitHubRateLimits } from "../../src/source/github/adapter";
import { GitHubCallMeter } from "../../src/source/github/call-meter";

const directories: string[] = [];
afterEach(async () => {
  log.configure({ sinks: [new ConsoleSink()] });
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function service(limits: GitHubRateLimits | Error) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-github-calls-"));
  directories.push(root);
  const records: LogRecord[] = [];
  log.configure({ sinks: [{ write: (record: LogRecord) => { records.push(record); } }] });
  const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
  const config = {
    hash: "h", root,
    settings: { artifacts: path.join(root, "artifacts"), workspaces: path.join(root, "worktrees"), runners: 1, labelPrefix: "conveyor" },
    web: {}, sources: { github: { type: "github" } }, labels: {}, pipelines: {}, agents: {},
    repositories: {
      app: { source: "github", address: "owner/my-app", folder: root, baseBranch: "main", pipeline: "default" },
      quiet: { source: "github", address: "owner/quiet", folder: root, baseBranch: "main", pipeline: "default" },
    },
  } as unknown as ConveyorConfig;
  const github = {
    async rateLimit() {
      if (limits instanceof Error) throw limits;
      return limits;
    },
  };
  const meter = new GitHubCallMeter();
  const conveyor = new ConveyorService(config, store, github as never, { githubCalls: meter });
  const call = (source: "tick" | "webhook", repository: string) =>
    meter.record({ method: "GET", route: "repos/:repo/pulls/:n", repository, source, durationMs: 1, ok: true, status: null });
  return { conveyor, store, records, call };
}

const reset = new Date(1_792_000_000_000).toISOString();

describe("hourly GitHub call summary", () => {
  test("logs the counts per source with the remaining limit, and one line per repository that made calls", async () => {
    const { conveyor, store, records, call } = await service({ core: { limit: 5000, remaining: 4000, resetAt: reset }, graphql: null });
    call("tick", "owner/my-app");
    call("tick", "owner/my-app");
    call("webhook", "owner/my-app");
    await conveyor.logGitHubCalls();
    expect(records.map(({ time: _time, ...record }) => record)).toEqual([
      { level: "info", message: "GitHub calls in the last hour", total: 3, tick: 2, webhook: 1, remaining: 4000, limit: 5000, resetAt: reset, since: expect.any(String) },
      { level: "info", message: "GitHub calls in the last hour for a repository", repository: "app", tick: 2, webhook: 1 },
    ]);
    store.close();
  });

  test("warns when less than a fifth of the rate limit is left", async () => {
    const { conveyor, store, records } = await service({ core: { limit: 5000, remaining: 999, resetAt: reset }, graphql: null });
    await conveyor.logGitHubCalls();
    expect(records.filter((record) => record.level === "warn")).toEqual([
      expect.objectContaining({ message: "GitHub rate limit is running low", remaining: 999, limit: 5000, resetAt: reset }),
    ]);
    store.close();
  });

  test("still logs the counts when the rate limit cannot be read", async () => {
    const { conveyor, store, records, call } = await service(new Error("gh unavailable"));
    call("tick", "owner/my-app");
    await conveyor.logGitHubCalls();
    expect(records.map((record) => [record.level, record.message])).toEqual([
      ["warn", "Could not read the GitHub rate limit"],
      ["info", "GitHub calls in the last hour"],
      ["info", "GitHub calls in the last hour for a repository"],
    ]);
    expect(records[1]).not.toHaveProperty("remaining");
    store.close();
  });
});
