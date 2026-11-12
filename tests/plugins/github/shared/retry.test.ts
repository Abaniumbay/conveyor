import { describe, expect, test } from "bun:test";

import { GitHubTransportError, type GitHubTransport, type GitHubTransportRequest } from "../../../../src/plugins/github/shared/adapter";
import { RetryingGitHubTransport } from "../../../../src/plugins/github/shared/retry";
import { classifyUpstreamError } from "../../../../src/tasks/upstream-error";

function fake(outcomes: Array<Error | unknown>) {
  const calls: GitHubTransportRequest[] = [];
  const transport: GitHubTransport = {
    async request<T>(request: GitHubTransportRequest): Promise<T> {
      calls.push(request);
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      return next as T;
    },
  };
  return { transport, calls };
}

const err = (message: string, stderr = message) => new GitHubTransportError(`GitHub API failed: ${message}`, 1, stderr);

function retrying(outcomes: Array<Error | unknown>, backoffMs = [5, 15, 45, 120]) {
  const waits: number[] = [];
  const { transport, calls } = fake(outcomes);
  const retry = new RetryingGitHubTransport(transport, { backoffMs, sleep: async (ms) => { waits.push(ms); } });
  return { retry, calls, waits };
}
const get = { method: "GET", path: "repos/o/r/issues/1" } as const;

describe("RetryingGitHubTransport", () => {
  test("REST 502 twice then success returns the success", async () => {
    const { retry, calls, waits } = retrying([err("Bad Gateway (HTTP 502)"), err("Bad Gateway (HTTP 502)"), { ok: true }]);
    expect(await retry.request<unknown>(get)).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([5, 15]);
  });

  test("GraphQL 'Something went wrong' then success", async () => {
    const { retry } = retrying([err("Something went wrong while executing your query. Please include `ABC` when reporting this issue."), { data: 1 }]);
    expect(await retry.request<unknown>({ method: "POST", path: "graphql", body: {} })).toEqual({ data: 1 });
  });

  test("truncated JSON is retried", async () => {
    const { retry, calls } = retrying([new SyntaxError("Unexpected end of JSON input"), { ok: 1 }]);
    expect(await retry.request<unknown>(get)).toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
  });

  test("HTTP 429 waits at least retry-after", async () => {
    const { retry, waits } = retrying([err("API rate limit exceeded (HTTP 429)", "HTTP/2.0 429\nretry-after: 30\n"), "done"]);
    expect(await retry.request<unknown>(get)).toBe("done");
    expect(waits).toHaveLength(1);
    expect(waits[0]!).toBeGreaterThanOrEqual(30_000);
  });

  test.each(["Not Found (HTTP 404)", "Validation Failed (HTTP 422)"])("permanent %s is thrown without retry", async (message) => {
    const { retry, calls, waits } = retrying([err(message), { ok: true }]);
    await expect(retry.request(get)).rejects.toThrow(message);
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  test("exhausted backoff throws the final error, still transient", async () => {
    const { retry, calls, waits } = retrying(Array.from({ length: 10 }, () => err("Bad Gateway (HTTP 502)")));
    const failure = await retry.request(get).then(() => null, (e: unknown) => e);
    expect(calls).toHaveLength(5);
    expect(waits).toEqual([5, 15, 45, 120]);
    expect(classifyUpstreamError(failure).kind).toBe("transient");
  });
});
