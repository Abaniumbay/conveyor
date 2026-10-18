import { afterEach, describe, expect, setSystemTime, test } from "bun:test";

import type { GitHubTransport, GitHubTransportRequest } from "../../../src/source/github/adapter";
import { DEFAULT_GITHUB_CACHE_LIFETIMES, GITHUB_MIRROR_VERSION, GitHubReadCache, type GitHubMirrorEntry, type GitHubMirrorStorage } from "../../../src/source/github/read-cache";

afterEach(() => { setSystemTime(); });

const MINUTE = 60_000;
const T0 = new Date("2026-10-18T10:00:00Z");

/** A GitHub that answers from `responses` and records every request that reaches it. */
class FakeGitHub implements GitHubTransport {
  readonly requests: string[] = [];
  constructor(readonly responses: Record<string, unknown> = {}) {}
  async request<T>(request: GitHubTransportRequest): Promise<T> {
    this.requests.push(`${request.method} ${request.path}`);
    return (this.responses[`${request.method} ${request.path}`] ?? null) as T;
  }
}

function storage(): GitHubMirrorStorage & { rows: Map<string, GitHubMirrorEntry> } {
  const rows = new Map<string, GitHubMirrorEntry>();
  return {
    rows,
    get: (key) => rows.get(key) ?? null,
    set: (key, entry) => { rows.set(key, entry); },
    delete: (key) => { rows.delete(key); },
    keys: (prefix) => [...rows.keys()].filter((key) => key.startsWith(prefix)),
  };
}

const ISSUE = "repos/owner/app/issues/7";
const issue = (fields: Record<string, unknown> = {}) => ({ number: 7, title: "Seven", labels: [{ name: "conveyor" }], updated_at: "2026-10-18T10:00:00Z", ...fields });
const get = (path: string, extra: Partial<GitHubTransportRequest> = {}): GitHubTransportRequest => ({ method: "GET", path, ...extra });
const repository = { full_name: "Owner/App" };

function cache(responses: Record<string, unknown> = {}) {
  setSystemTime(T0);
  const github = new FakeGitHub(responses);
  const rows = storage();
  const instance = new GitHubReadCache(github);
  instance.useStorage(rows, DEFAULT_GITHUB_CACHE_LIFETIMES);
  return { github, rows, instance };
}

describe("reads", () => {
  test("a read within its lifetime is answered from the copy", async () => {
    const { github, instance } = cache({ [`GET ${ISSUE}`]: issue() });
    await instance.request(get(ISSUE));
    setSystemTime(new Date(T0.getTime() + 59 * MINUTE));
    expect(await instance.request<unknown>(get(ISSUE))).toEqual(issue());
    expect(github.requests).toEqual([`GET ${ISSUE}`]);
  });

  test("an issue older than its lifetime is read again", async () => {
    const { github, instance } = cache({ [`GET ${ISSUE}`]: issue() });
    await instance.request(get(ISSUE));
    setSystemTime(new Date(T0.getTime() + 60 * MINUTE));
    await instance.request(get(ISSUE));
    expect(github.requests).toHaveLength(2);
  });

  test("an item stored in another format version is read again", async () => {
    const { github, rows, instance } = cache({ [`GET ${ISSUE}`]: issue() });
    rows.set(ISSUE, { kind: "issue", version: GITHUB_MIRROR_VERSION + 1, value: issue({ title: "Old shape" }), at: T0.getTime() });
    expect(await instance.request<unknown>(get(ISSUE))).toEqual(issue());
    expect(rows.get(ISSUE)?.version).toBe(GITHUB_MIRROR_VERSION);
  });

  test("the repository part of a path is matched without regard to case", async () => {
    const { github, instance } = cache({ "GET repos/Owner/App/issues/7": issue() });
    await instance.request(get("repos/Owner/App/issues/7"));
    await instance.request(get("repos/owner/app/issues/7"));
    expect(github.requests).toHaveLength(1);
  });

  test("the rate limit and webhook state are never copied", async () => {
    const { github, instance } = cache();
    for (const path of ["rate_limit", "repos/owner/app/hooks", "repos/owner/app/hooks/1/deliveries?per_page=100"]) {
      await instance.request(get(path));
      await instance.request(get(path));
    }
    expect(github.requests).toHaveLength(6);
  });

  test("a GraphQL query is copied; a mutation is not and drops the copied queries", async () => {
    const { github, instance } = cache();
    const query: GitHubTransportRequest = { method: "POST", path: "graphql", body: { query: "query { node }" } };
    await instance.request(query);
    await instance.request(query);
    await instance.request({ method: "POST", path: "graphql", body: { query: "mutation { resolve }" } });
    await instance.request(query);
    expect(github.requests).toEqual(["POST graphql", "POST graphql", "POST graphql"]);
  });
});

describe("check runs", () => {
  const CHECKS = "repos/owner/app/commits/abc/check-runs?per_page=100";
  const page = (runs: Array<Record<string, unknown>>) => [{ total_count: runs.length, check_runs: runs }];

  test("a commit whose runs all finished is not read again", async () => {
    const { github, instance } = cache({ [`GET ${CHECKS}`]: page([{ id: 1, name: "test", status: "completed", conclusion: "success" }]) });
    await instance.request(get(CHECKS, { paginate: true }));
    setSystemTime(new Date(T0.getTime() + 24 * 60 * MINUTE));
    await instance.request(get(CHECKS, { paginate: true }));
    expect(github.requests).toHaveLength(1);
  });

  test("a commit with a running check is read again after the running-checks lifetime", async () => {
    const { github, instance } = cache({ [`GET ${CHECKS}`]: page([{ id: 1, name: "test", status: "in_progress", conclusion: null }]) });
    await instance.request(get(CHECKS, { paginate: true }));
    setSystemTime(new Date(T0.getTime() + 14 * MINUTE));
    await instance.request(get(CHECKS, { paginate: true }));
    setSystemTime(new Date(T0.getTime() + 15 * MINUTE));
    await instance.request(get(CHECKS, { paginate: true }));
    expect(github.requests).toHaveLength(2);
  });

  test("a check_run delivery updates the commit's copy, which then needs no read", async () => {
    const { github, instance } = cache({ [`GET ${CHECKS}`]: page([{ id: 1, name: "test", status: "in_progress", conclusion: null }]) });
    await instance.request(get(CHECKS, { paginate: true }));
    instance.applyDelivery("check_run", { repository, action: "completed", check_run: { id: 1, name: "test", head_sha: "abc", status: "completed", conclusion: "success" } });
    setSystemTime(new Date(T0.getTime() + 60 * MINUTE));
    expect(await instance.request<unknown>(get(CHECKS, { paginate: true }))).toEqual(page([{ id: 1, name: "test", head_sha: "abc", status: "completed", conclusion: "success" }]));
    expect(github.requests).toHaveLength(1);
  });
});

describe("deliveries", () => {
  test("an issue delivery replaces the copy of the issue", async () => {
    const { github, instance } = cache({ [`GET ${ISSUE}`]: issue() });
    await instance.request(get(ISSUE));
    instance.applyDelivery("issues", { repository, action: "labeled", issue: issue({ labels: [{ name: "conveyor" }, { name: "priority" }], updated_at: "2026-10-18T10:05:00Z" }) });
    expect(await instance.request<unknown>(get(ISSUE))).toMatchObject({ labels: [{ name: "conveyor" }, { name: "priority" }] });
    expect(github.requests).toHaveLength(1);
  });

  test("an issue delivery older than the copy changes nothing", async () => {
    const { instance } = cache({ [`GET ${ISSUE}`]: issue({ updated_at: "2026-10-18T10:05:00Z" }) });
    await instance.request(get(ISSUE));
    instance.applyDelivery("issues", { repository, action: "labeled", issue: issue({ title: "Older", updated_at: "2026-10-18T09:00:00Z" }) });
    expect(await instance.request<unknown>(get(ISSUE))).toMatchObject({ title: "Seven" });
  });

  test("a pull request delivery replaces the copy of the pull request", async () => {
    const { github, instance } = cache();
    instance.applyDelivery("pull_request", { repository, action: "synchronize", pull_request: { number: 9, head: { sha: "new" }, mergeable: null, state: "open", updated_at: "2026-10-18T10:05:00Z" } });
    expect(await instance.request<unknown>(get("repos/owner/app/pulls/9"))).toMatchObject({ head: { sha: "new" } });
    expect(github.requests).toEqual([]);
  });

  test("a review delivery drops the pull request's reviews, so they are read again", async () => {
    const { github, instance } = cache();
    await instance.request(get("repos/owner/app/pulls/9/reviews?per_page=100"));
    instance.applyDelivery("pull_request_review", { repository, action: "submitted", pull_request: { number: 9 } });
    await instance.request(get("repos/owner/app/pulls/9/reviews?per_page=100"));
    expect(github.requests).toHaveLength(2);
  });

  test("a member delivery drops that person's permission", async () => {
    const { github, instance } = cache();
    await instance.request(get("repos/owner/app/collaborators/someone/permission"));
    instance.applyDelivery("member", { repository, action: "edited", member: { login: "someone" } });
    await instance.request(get("repos/owner/app/collaborators/someone/permission"));
    expect(github.requests).toHaveLength(2);
  });

  test("a comment delivery drops the issue's comments, not the issue", async () => {
    const { github, instance } = cache({ [`GET ${ISSUE}`]: issue() });
    await instance.request(get(ISSUE));
    await instance.request(get(`${ISSUE}/comments?per_page=100`));
    instance.applyDelivery("issue_comment", { repository, action: "created", issue: issue({ updated_at: "2026-10-18T10:05:00Z" }), comment: { id: 1 } });
    await instance.request(get(ISSUE));
    await instance.request(get(`${ISSUE}/comments?per_page=100`));
    expect(github.requests).toEqual([`GET ${ISSUE}`, `GET ${ISSUE}/comments?per_page=100`, `GET ${ISSUE}/comments?per_page=100`]);
  });
});

describe("Conveyor's own writes", () => {
  test("an issue edit stores the issue GitHub returns", async () => {
    const { github, instance } = cache({ [`PATCH ${ISSUE}`]: issue({ title: "Renamed" }) });
    await instance.request({ method: "PATCH", path: ISSUE, body: { title: "Renamed" } });
    expect(await instance.request<unknown>(get(ISSUE))).toMatchObject({ title: "Renamed" });
    expect(github.requests).toEqual([`PATCH ${ISSUE}`]);
  });

  test("a label write keeps the labels GitHub returns on the held issue", async () => {
    const { github, instance } = cache({ [`GET ${ISSUE}`]: issue(), [`PUT ${ISSUE}/labels`]: [{ name: "conveyor" }, { name: "conveyor:review" }] });
    await instance.request(get(ISSUE));
    await instance.request({ method: "PUT", path: `${ISSUE}/labels`, body: { labels: ["conveyor", "conveyor:review"] } });
    expect(await instance.request<unknown>(get(ISSUE))).toMatchObject({ labels: [{ name: "conveyor" }, { name: "conveyor:review" }] });
    expect(github.requests).toEqual([`GET ${ISSUE}`, `PUT ${ISSUE}/labels`]);
  });

  test("a pull request edit stores the pull request GitHub returns", async () => {
    const { github, instance } = cache({ "PATCH repos/owner/app/pulls/9": { number: 9, body: "New" } });
    await instance.request({ method: "PATCH", path: "repos/owner/app/pulls/9", body: { body: "New" } });
    expect(await instance.request<unknown>(get("repos/owner/app/pulls/9"))).toEqual({ number: 9, body: "New" });
    expect(github.requests).toHaveLength(1);
  });

  test("a merge drops the copy of the pull request", async () => {
    const { github, instance } = cache();
    await instance.request(get("repos/owner/app/pulls/9"));
    await instance.request({ method: "PUT", path: "repos/owner/app/pulls/9/merge", body: {} });
    await instance.request(get("repos/owner/app/pulls/9"));
    expect(github.requests.filter((request) => request.startsWith("GET"))).toHaveLength(2);
  });
});

test("forgetting a repository makes its next reads go to GitHub", async () => {
  const { github, instance } = cache({ [`GET ${ISSUE}`]: issue() });
  await instance.request(get(ISSUE));
  instance.forgetRepository("Owner/App");
  await instance.request(get(ISSUE));
  expect(github.requests).toHaveLength(2);
});
