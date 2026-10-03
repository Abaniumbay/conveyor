import { describe, expect, test } from "bun:test";

import { GitHubAdapter, GitHubTransportError, type GitHubTransport, type GitHubTransportRequest } from "../../src/source/github/adapter";
import { GitHubCodeHost } from "../../src/source/github/codehost";

class FakeTransport implements GitHubTransport {
  readonly requests: GitHubTransportRequest[] = [];
  constructor(private readonly responses: unknown[]) {}
  async request<T>(request: GitHubTransportRequest): Promise<T> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error("unexpected GitHub request");
    return response as T;
  }
}

const ID = "github:o/r#pr-5";
const host = (responses: unknown[]) => {
  const transport = new FakeTransport(responses);
  return { transport, host: new GitHubCodeHost(new GitHubAdapter(transport, "conveyor")) };
};
const unprocessable = new GitHubTransportError("gh failed", 1, "gh: Unprocessable Entity (HTTP 422)");

describe("GitHub findings projection", () => {
  test("creates an inline review comment at the head with the finding marker", async () => {
    const { transport, host: h } = host([{ id: 11, html_url: "https://x/c11" }]);
    const result = await h.createFinding({ address: "o/r", id: ID, findingId: "F1", body: "Fix it", headSha: "h1", path: "a.ts", line: 4 });
    expect(result).toEqual({ url: "https://x/c11", projection: "inline:11" });
    expect(transport.requests[0]).toMatchObject({ method: "POST", path: "repos/o/r/pulls/5/comments" });
    expect(transport.requests[0]!.body).toMatchObject({ commit_id: "h1", path: "a.ts", line: 4, side: "RIGHT" });
    expect((transport.requests[0]!.body as { body: string }).body).toContain("<!-- conveyor:finding:F1 -->");
  });

  test("falls back to a managed PR comment when GitHub rejects the position", async () => {
    const { transport, host: h } = host([unprocessable, { id: 12, html_url: "https://x/c12" }]);
    const result = await h.createFinding({ address: "o/r", id: ID, findingId: "F1", body: "Fix it", headSha: "h1", path: "a.ts", line: 400 });
    expect(result).toEqual({ url: "https://x/c12", projection: "comment:12" });
    expect(transport.requests[1]).toMatchObject({ method: "POST", path: "repos/o/r/issues/5/comments" });
    expect((transport.requests[1]!.body as { body: string }).body).toContain("<!-- conveyor:finding:F1 -->");
    expect((transport.requests[1]!.body as { body: string }).body).toContain("a.ts:400");
  });

  test("posts a managed comment when no position is given, and does not swallow other errors", async () => {
    const { transport, host: h } = host([{ id: 13, html_url: "https://x/c13" }]);
    await h.createFinding({ address: "o/r", id: ID, findingId: "F2", body: "General", headSha: "h1" });
    expect(transport.requests[0]).toMatchObject({ path: "repos/o/r/issues/5/comments" });
    const broken = host([new GitHubTransportError("gh failed HTTP 500", 1, "HTTP 500")]);
    await expect(broken.host.createFinding({ address: "o/r", id: ID, findingId: "F3", body: "x", headSha: "h", path: "a", line: 1 })).rejects.toThrow("HTTP 500");
  });

  test("projects a resolution as a reply, a reaction and a resolved thread on an inline comment", async () => {
    const threads = { data: { repository: { pullRequest: { reviewThreads: { nodes: [
      { id: "T9", isResolved: false, comments: { nodes: [{ id: "C9", databaseId: 11, author: { login: "conveyor" }, body: "x", url: "u", path: "a.ts", line: 1, createdAt: "t", pullRequestReview: null }] } },
    ] } } } } };
    const inline = host([{}, {}, threads, { data: { resolveReviewThread: { thread: { isResolved: true } } } }]);
    await inline.host.resolveFindingProjection({
      address: "o/r", id: ID, findingId: "F1", projection: "inline:11", body: "Fix it", actor: "kaveh", verdict: "fixed", message: "👍 Fixed in abc1234 by Kaveh: done",
    });
    expect(inline.transport.requests[0]).toMatchObject({ method: "POST", path: "repos/o/r/pulls/5/comments/11/replies", body: { body: "👍 Fixed in abc1234 by Kaveh: done" } });
    expect(inline.transport.requests[1]).toMatchObject({ method: "POST", path: "repos/o/r/pulls/comments/11/reactions", body: { content: "+1" } });
    expect(inline.transport.requests[3]).toMatchObject({ method: "POST", path: "graphql", body: { variables: { thread: "T9" } } });
    expect((inline.transport.requests[3]!.body as { query: string }).query).toContain("resolveReviewThread");
  });

  test("a failing reaction or thread lookup does not fail an inline resolution", async () => {
    const inline = host([{}, new Error("reactions are disabled"), new Error("GraphQL down")]);
    await inline.host.resolveFindingProjection({
      address: "o/r", id: ID, findingId: "F1", projection: "inline:11", body: "Fix it", actor: "kaveh", verdict: "fixed", message: "m",
    });
    expect(inline.transport.requests).toHaveLength(3);
  });

  test("edits a managed comment's heading to the resolution and reacts on it", async () => {
    const managed = host([{}, {}]);
    await managed.host.resolveFindingProjection({
      address: "o/r", id: ID, findingId: "F2", projection: "comment:12", body: "General", actor: "kaveh", verdict: "invalid", message: "👎 Not changed by Kaveh: nope",
    });
    expect(managed.transport.requests[0]).toMatchObject({ method: "PATCH", path: "repos/o/r/issues/comments/12" });
    const edited = (managed.transport.requests[0]!.body as { body: string }).body;
    expect(edited).toContain("<!-- conveyor:finding:F2 -->");
    expect(edited).toContain("👎 Not changed by Kaveh: nope");
    expect(edited).toContain("General");
    expect(managed.transport.requests[1]).toMatchObject({ method: "POST", path: "repos/o/r/issues/comments/12/reactions", body: { content: "-1" } });
  });

  test("answers an imported thread, reacts on its first comment and resolves it", async () => {
    const native = host([
      { data: { addPullRequestReviewThreadReply: { comment: { id: "R1" } } } },
      { data: { node: { comments: { nodes: [{ id: "C1" }] } } } },
      { data: { addReaction: { reaction: { content: "THUMBS_DOWN" } } } },
      { data: { resolveReviewThread: { thread: { isResolved: true } } } },
    ]);
    await native.host.resolveNativeFinding({ address: "o/r", id: ID, providerKey: "thread:PRRT_1", verdict: "invalid", message: "👎 Not changed by Kaveh: wrong" });
    const bodies = native.transport.requests.map((request) => request.body as { query: string; variables: Record<string, unknown> });
    expect(bodies[0]!.query).toContain("addPullRequestReviewThreadReply");
    expect(bodies[0]!.variables).toEqual({ thread: "PRRT_1", body: "👎 Not changed by Kaveh: wrong" });
    expect(bodies[2]!.variables).toEqual({ subject: "C1", content: "THUMBS_DOWN" });
    expect(bodies[3]!.query).toContain("resolveReviewThread");
  });

  test("an imported thread that cannot be resolved fails, but a failed reaction does not", async () => {
    const reactionFails = host([{ data: {} }, new Error("no reactions"), { data: {} }]);
    await reactionFails.host.resolveNativeFinding({ address: "o/r", id: ID, providerKey: "thread:PRRT_1", verdict: "fixed", message: "m" });
    const resolveFails = host([{ data: {} }, { data: { node: null } }, { errors: [{ message: "Resource not accessible" }] }]);
    await expect(resolveFails.host.resolveNativeFinding({ address: "o/r", id: ID, providerKey: "thread:PRRT_1", verdict: "fixed", message: "m" }))
      .rejects.toThrow("Resource not accessible");
  });

  test("answers a changes-requested review with a pull request comment", async () => {
    const native = host([{ id: 77, html_url: "https://x/c77" }]);
    await native.host.resolveNativeFinding({ address: "o/r", id: ID, providerKey: "review:900", verdict: "fixed", message: "👍 Fixed in abc by Kaveh: ok" });
    expect(native.transport.requests[0]).toMatchObject({ method: "POST", path: "repos/o/r/issues/5/comments" });
    expect((native.transport.requests[0]!.body as { body: string }).body).toBe("👍 Fixed in abc by Kaveh: ok\n\n(Re: review 900)");
  });
});

const thread = (over: Record<string, unknown> = {}, comment: Record<string, unknown> = {}) => ({
  id: "T1", isResolved: false,
  comments: { nodes: [{ id: "C1", databaseId: 101, author: { login: "alice" }, body: "Rename", url: "https://x/t1", path: "a.ts", line: 7, createdAt: "t", pullRequestReview: { databaseId: 900 }, ...comment }] },
  ...over,
});
const graphql = (...threads: unknown[]) => ({ data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } } });
const review = (over: Record<string, unknown> = {}) => ({
  id: 900, state: "CHANGES_REQUESTED", user: { login: "alice" }, body: "Needs work", html_url: "https://x/r900", submitted_at: "t", ...over,
});

describe("GitHub native review import", () => {
  test("lists human threads and changes-requested reviews", async () => {
    const { transport, host: h } = host([graphql(thread(), thread({ id: "T2", isResolved: true }, { databaseId: 102, url: "https://x/t2" })), [review({ id: 901, user: { login: "bob" }, body: "Overall no", html_url: "https://x/r901" })]]);
    const artifacts = await h.listReviewArtifacts({ address: "o/r", id: ID });
    expect(artifacts).toEqual([
      { providerKey: "thread:T1", author: "alice", body: "Rename", url: "https://x/t1", path: "a.ts", line: 7, resolved: false },
      { providerKey: "thread:T2", author: "alice", body: "Rename", url: "https://x/t2", path: "a.ts", line: 7, resolved: true },
      { providerKey: "review:901", author: "bob", body: "Overall no", url: "https://x/r901", path: null, line: null, resolved: false },
    ]);
    expect(transport.requests[0]).toMatchObject({ method: "POST", path: "graphql" });
    expect(JSON.stringify(transport.requests[0]!.body)).toContain("reviewThreads");
    expect(transport.requests[0]!.body).toMatchObject({ variables: { owner: "o", name: "r", number: 5 } });
  });

  test("excludes Conveyor's own comments, bots, and reviews already represented by an inline thread", async () => {
    const { host: h } = host([
      graphql(thread(), thread({ id: "T3" }, { body: "<!-- conveyor:finding:F1 -->\nFix" }), thread({ id: "T4" }, { author: { login: "ci[bot]" } })),
      [review(), review({ id: 902, user: { login: "bot[bot]" } }), review({ id: 903, body: "<!-- conveyor:finding:F9 -->" }), review({ id: 904, state: "COMMENTED" })],
    ]);
    const artifacts = await h.listReviewArtifacts({ address: "o/r", id: ID });
    expect(artifacts.map((a) => a.providerKey)).toEqual(["thread:T1"]);
  });

  test("a later approval by the same author resolves a changes-requested review", async () => {
    const { host: h } = host([graphql(), [review({ id: 1 }), review({ id: 2, state: "APPROVED" })]]);
    const [artifact] = await h.listReviewArtifacts({ address: "o/r", id: ID });
    expect(artifact).toMatchObject({ providerKey: "review:1", resolved: true });
  });

  test("reads every page of review threads", async () => {
    const page = (nodes: unknown[], hasNextPage: boolean, endCursor: string | null) =>
      ({ data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage, endCursor } } } } } });
    const { transport, host: h } = host([page([thread()], true, "c1"), page([thread({ id: "T2" })], false, null), []]);
    const artifacts = await h.listReviewArtifacts({ address: "o/r", id: ID });
    expect(artifacts.map((a) => a.providerKey)).toEqual(["thread:T1", "thread:T2"]);
    expect(transport.requests[0]!.body).toMatchObject({ variables: { cursor: null } });
    expect(transport.requests[1]!.body).toMatchObject({ variables: { cursor: "c1" } });
  });

  test("a page that cannot be continued fails instead of returning a partial set", async () => {
    const broken = { data: { repository: { pullRequest: { reviewThreads: { nodes: [thread()], pageInfo: { hasNextPage: true, endCursor: null } } } } } };
    const { host: h } = host([broken, []]);
    await expect(h.listReviewArtifacts({ address: "o/r", id: ID })).rejects.toThrow("cannot be paginated");
    const failing = host([{ data: { repository: { pullRequest: { reviewThreads: { nodes: [thread()], pageInfo: { hasNextPage: true, endCursor: "c" } } } } } }, new Error("page 2 failed"), []]);
    await expect(failing.host.listReviewArtifacts({ address: "o/r", id: ID })).rejects.toThrow("page 2 failed");
  });

  test("a GraphQL error is thrown as an infrastructure failure", async () => {
    const { host: h } = host([{ errors: [{ message: "boom" }] }]);
    await expect(h.listReviewArtifacts({ address: "o/r", id: ID })).rejects.toThrow("boom");
  });
});
