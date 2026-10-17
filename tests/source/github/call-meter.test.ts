import { afterEach, describe, expect, test } from "bun:test";

import { ConsoleSink, log, type LogRecord } from "../../../src/log/logger";
import { GitHubTransportError, type GitHubTransport, type GitHubTransportRequest } from "../../../src/source/github/adapter";
import {
  GitHubCallMeter,
  MeteredGitHubTransport,
  currentGitHubCallSource,
  githubRepository,
  githubRoute,
  withGitHubCallSource,
} from "../../../src/source/github/call-meter";

afterEach(() => log.configure({ sinks: [new ConsoleSink()] }));

function capture(): LogRecord[] {
  const records: LogRecord[] = [];
  log.configure({ level: "debug", sinks: [{ write: (record: LogRecord) => { records.push(record); } }] });
  return records;
}

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("githubRoute", () => {
  test("replaces the repository and numbers", () => {
    expect(githubRoute("repos/owner/my-app/pulls/12")).toBe("repos/:repo/pulls/:n");
  });
  test("replaces a commit SHA", () => {
    expect(githubRoute(`repos/owner/my-app/commits/${SHA}/check-runs?per_page=100`)).toBe("repos/:repo/commits/:sha/check-runs");
  });
  test("drops the query string", () => {
    expect(githubRoute("repos/owner/my-app/issues?state=all&per_page=100&since=2026-10-17T00:00:00Z")).toBe("repos/:repo/issues");
  });
  test("replaces a file path", () => {
    expect(githubRoute("repos/owner/my-app/contents/.github/workflows/ci.yml?ref=main")).toBe("repos/:repo/contents/:path");
  });
  test("replaces a branch name", () => {
    expect(githubRoute("repos/owner/my-app/git/refs/heads/conveyor/12-fix")).toBe("repos/:repo/git/refs/heads/:ref");
  });
  test("replaces a label name", () => {
    expect(githubRoute("repos/owner/my-app/issues/3/labels/conveyor%3Aready")).toBe("repos/:repo/issues/:n/labels/:name");
  });
  test("replaces a collaborator login", () => {
    expect(githubRoute("repos/owner/my-app/collaborators/someone/permission")).toBe("repos/:repo/collaborators/:login/permission");
  });
  test("replaces an organization", () => {
    expect(githubRoute("orgs/owner/issue-fields?per_page=100")).toBe("orgs/:org/issue-fields");
  });
  test("keeps paths outside a repository", () => {
    expect(githubRoute("graphql")).toBe("graphql");
  });
});

describe("githubRepository", () => {
  test("reads the lower-cased owner/repo of a repository path", () => {
    expect(githubRepository("repos/Owner/My-App/issues?state=all")).toBe("owner/my-app");
  });
  test("is null outside a repository", () => {
    expect(githubRepository("rate_limit")).toBeNull();
  });
});

describe("withGitHubCallSource", () => {
  test("the source follows asynchronous work and nested sources win", async () => {
    expect(currentGitHubCallSource()).toBe("other");
    const seen = await withGitHubCallSource("tick", async () => {
      await Bun.sleep(1);
      const inner = await withGitHubCallSource("webhook", async () => { await Bun.sleep(1); return currentGitHubCallSource(); });
      return [currentGitHubCallSource(), inner];
    });
    expect(seen).toEqual(["tick", "webhook"]);
  });
});

describe("GitHubCallMeter", () => {
  const call = (source: "tick" | "webhook", route = "repos/:repo/pulls/:n", repository: string | null = "owner/my-app") =>
    ({ method: "GET" as const, route, repository, source, durationMs: 1, ok: true, status: null });

  test("counts per source, repository and route", () => {
    const meter = new GitHubCallMeter(0);
    meter.record(call("tick"), 1_000);
    meter.record(call("tick", "repos/:repo/issues"), 2_000);
    meter.record(call("webhook"), 3_000);
    expect(meter.summary(60 * 60_000, 4_000)).toEqual({
      total: 3,
      bySource: { tick: 2, webhook: 1 },
      byRepository: { "owner/my-app": { tick: 2, webhook: 1 } },
      byRoute: { "GET repos/:repo/pulls/:n": 2, "GET repos/:repo/issues": 1 },
    });
  });

  test("a summary covers only its window", () => {
    const meter = new GitHubCallMeter(0);
    meter.record(call("tick"), 0);
    meter.record(call("webhook"), 30 * 60_000);
    expect(meter.summary(10 * 60_000, 31 * 60_000).bySource).toEqual({ webhook: 1 });
  });

  test("calls older than an hour are dropped", () => {
    const meter = new GitHubCallMeter(0);
    meter.record(call("tick"), 0);
    meter.record(call("webhook"), 61 * 60_000);
    expect(meter.summary(60 * 60_000, 61 * 60_000).total).toBe(1);
  });

  test("reading the rate limit is not counted", () => {
    const meter = new GitHubCallMeter(0);
    meter.record(call("tick", "rate_limit", null), 0);
    expect(meter.summary(60 * 60_000, 1).total).toBe(0);
  });
});

describe("MeteredGitHubTransport", () => {
  const transport = (fail?: GitHubTransportError): GitHubTransport => ({
    async request<T>(_request: GitHubTransportRequest): Promise<T> {
      if (fail) throw fail;
      return { ok: true } as T;
    },
  });

  test("counts a request under the current source and logs it at debug level", async () => {
    const records = capture();
    const meter = new GitHubCallMeter();
    const metered = new MeteredGitHubTransport(transport(), meter);
    await withGitHubCallSource("webhook", () => metered.request({ method: "GET", path: "repos/owner/my-app/pulls/3" }));
    expect(meter.summary().bySource).toEqual({ webhook: 1 });
    expect(records).toEqual([expect.objectContaining({
      level: "debug", message: "GitHub call", method: "GET", route: "repos/:repo/pulls/:n", source: "webhook", address: "owner/my-app", ok: true,
    })]);
  });

  test("counts a failed request with its HTTP status and rethrows it", async () => {
    const records = capture();
    const meter = new GitHubCallMeter();
    const error = new GitHubTransportError("GitHub API GET repos/owner/my-app/pulls/3 failed", 1, "gh: Not Found (HTTP 404)");
    const metered = new MeteredGitHubTransport(transport(error), meter);
    await expect(metered.request({ method: "GET", path: "repos/owner/my-app/pulls/3" })).rejects.toBe(error);
    expect(meter.summary().total).toBe(1);
    expect(records[0]).toMatchObject({ ok: false, status: 404 });
  });

  test("a rate-limit refusal is warned about once, not for every refused request", async () => {
    const records = capture();
    const error = new GitHubTransportError("GitHub API GET repos/owner/my-app/pulls/3 failed", 1, "gh: API rate limit exceeded (HTTP 403)");
    const metered = new MeteredGitHubTransport(transport(error), new GitHubCallMeter());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await metered.request({ method: "GET", path: "repos/owner/my-app/pulls/3" }).catch(() => {});
    }
    expect(records.filter((record) => record.level === "warn").map((record) => record.message)).toEqual(["GitHub refused a request for its rate limit"]);
  });
});
