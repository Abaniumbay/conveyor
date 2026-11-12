import { afterEach, describe, expect, test } from "bun:test";

import { ConsoleSink, log, type LogRecord } from "../../../../src/log/logger";
import { GitHubTransportError, type GitHubTransport, type GitHubTransportRequest } from "../../../../src/plugins/github/shared/adapter";
import { MeteredGitHubTransport, githubRepository, githubRoute } from "../../../../src/plugins/github/shared/call-meter";
import { CallMeter, withCallSource } from "../../../../src/source/calls";

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

describe("MeteredGitHubTransport", () => {
  const transport = (fail?: GitHubTransportError): GitHubTransport => ({
    async request<T>(_request: GitHubTransportRequest): Promise<T> {
      if (fail) throw fail;
      return { ok: true } as T;
    },
  });

  test("counts a request under the current source and logs it at debug level", async () => {
    const records = capture();
    const meter = new CallMeter();
    const metered = new MeteredGitHubTransport(transport(), meter);
    await withCallSource("webhook", () => metered.request({ method: "GET", path: "repos/owner/my-app/pulls/3" }));
    expect(meter.summary().bySource).toEqual({ webhook: 1 });
    expect(records).toEqual([expect.objectContaining({
      level: "debug", message: "GitHub call", method: "GET", route: "repos/:repo/pulls/:n", source: "webhook", address: "owner/my-app", ok: true,
    })]);
  });

  test("counts a failed request with its HTTP status and rethrows it", async () => {
    const records = capture();
    const meter = new CallMeter();
    const error = new GitHubTransportError("GitHub API GET repos/owner/my-app/pulls/3 failed", 1, "gh: Not Found (HTTP 404)");
    const metered = new MeteredGitHubTransport(transport(error), meter);
    await expect(metered.request({ method: "GET", path: "repos/owner/my-app/pulls/3" })).rejects.toBe(error);
    expect(meter.summary().total).toBe(1);
    expect(records[0]).toMatchObject({ ok: false, status: 404 });
  });

  test("a rate-limit refusal is warned about once, not for every refused request", async () => {
    const records = capture();
    const error = new GitHubTransportError("GitHub API GET repos/owner/my-app/pulls/3 failed", 1, "gh: API rate limit exceeded (HTTP 403)");
    const metered = new MeteredGitHubTransport(transport(error), new CallMeter());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await metered.request({ method: "GET", path: "repos/owner/my-app/pulls/3" }).catch(() => {});
    }
    expect(records.filter((record) => record.level === "warn").map((record) => record.message)).toEqual(["GitHub refused a request for its rate limit"]);
  });
});
