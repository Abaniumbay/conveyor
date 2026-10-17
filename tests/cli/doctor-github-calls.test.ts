import { describe, expect, test } from "bun:test";

import type { GitHubCallReport } from "../../src/app/service";
import { githubCallCheck } from "../../src/cli/commands/doctor";

const report = (over: Partial<GitHubCallReport> = {}): GitHubCallReport => ({
  countingSince: "2026-01-01T00:00:00.000Z", windowMs: 3_600_000, total: 12,
  bySource: { tick: 5, webhook: 4, wait: 3 }, byRepository: {}, byRoute: {},
  rateLimit: { limit: 5000, remaining: 4200, resetAt: "2026-10-17T11:00:00.000Z" }, ...over,
});

describe("conveyor doctor GitHub calls", () => {
  test("shows the last hour's calls by source and the rate limit left", () => {
    expect(githubCallCheck(report())).toEqual({
      name: "GitHub calls", status: "ok",
      detail: "12 calls in the last hour (tick 5, webhook 4, wait 3); 4200 of 5000 requests left until 2026-10-17T11:00:00.000Z",
    });
  });

  test("warns when less than a fifth of the rate limit is left", () => {
    expect(githubCallCheck(report({ rateLimit: { limit: 5000, remaining: 900, resetAt: "2026-10-17T11:00:00.000Z" } }))).toMatchObject({ status: "warn" });
  });

  test("says when the rate limit could not be read", () => {
    expect(githubCallCheck(report({ rateLimit: null })).detail).toContain("the rate limit could not be read");
  });

  test("says when counting started less than an hour ago", () => {
    const since = new Date(Date.now() - 600_000).toISOString();
    expect(githubCallCheck(report({ countingSince: since })).detail).toContain(`since the service started at ${since}`);
  });
});
