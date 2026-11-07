import { describe, expect, test } from "bun:test";

import { GitHubAdapter, GitHubTransportError, type GitHubTransport, type GitHubTransportRequest } from "../../../src/source/github/adapter";
import { RetryingGitHubTransport } from "../../../src/source/github/retry";

/** A fake GitHub that stores what is created; the first create of each kind can "lose" its response with a 502. */
class FakeGitHub implements GitHubTransport {
  issues: Array<{ id: number; number: number; html_url: string; title: string; body: string; state: "open"; labels: []; updated_at: string }> = [];
  comments: Array<{ id: number; html_url: string; body: string }> = [];
  pulls: Array<{ number: number; html_url: string; state: string; head: string }> = [];
  constructor(private failFirstCreate = false) {}

  private lose(): never {
    this.failFirstCreate = false;
    throw new GitHubTransportError("GitHub API failed: Bad Gateway (HTTP 502)", 1, "HTTP 502");
  }

  async request<T>(request: GitHubTransportRequest): Promise<T> {
    const { method, path } = request;
    const body = request.body as Record<string, string>;
    if (method === "GET" && path === "repos/o/r/issues/3") return { id: 7, number: 3 } as T;
    if (method === "GET" && path.includes("/sub_issues")) return this.issues as T;
    if (method === "POST" && path === "repos/o/r/issues") {
      const issue = { id: 100 + this.issues.length, number: 10 + this.issues.length, html_url: "u", title: body.title!, body: body.body!, state: "open" as const, labels: [] as [], updated_at: "x" };
      this.issues.push(issue);
      if (this.failFirstCreate) this.lose();
      return issue as T;
    }
    const issuePath = /^repos\/o\/r\/issues\/(\d+)$/.exec(path);
    const stored = issuePath ? this.issues.find((issue) => issue.number === Number(issuePath[1])) : undefined;
    if (stored && method === "GET") return stored as T;
    if (stored && method === "PATCH") {
      stored.body = body.body!;
      return stored as T;
    }
    if (method === "GET" && path.includes("/comments")) return this.comments as T;
    if (method === "POST" && path.endsWith("/comments")) {
      const comment = { id: this.comments.length + 1, html_url: "c", body: body.body! };
      this.comments.push(comment);
      if (this.failFirstCreate) this.lose();
      return comment as T;
    }
    if (method === "GET" && path.startsWith("repos/o/r/pulls?")) return this.pulls as T;
    if (method === "POST" && path === "repos/o/r/pulls") {
      const pull = { number: this.pulls.length + 1, html_url: "p", state: "open", head: body.head! };
      this.pulls.push(pull);
      if (this.failFirstCreate) this.lose();
      return pull as T;
    }
    throw new Error(`unexpected ${method} ${path}`);
  }
}

function adapterOver(github: FakeGitHub) {
  const transport = new RetryingGitHubTransport(github, { backoffMs: [1, 1], sleep: async () => {} });
  return new GitHubAdapter(transport, "conveyor");
}
const child = (title: string) => ({ address: "o/r", parentNumber: 3, title, body: "body", labels: [] as string[] });

describe("idempotent creates", () => {
  test("child issue created but answered 502 is returned on retry, exactly one exists", async () => {
    const github = new FakeGitHub(true);
    const created = await adapterOver(github).createChildIssue(child("Do it"));
    expect(github.issues).toHaveLength(1);
    expect(created.number).toBe(github.issues[0]!.number);
  });

  test("same parent and title twice returns the same issue", async () => {
    const github = new FakeGitHub();
    const adapter = adapterOver(github);
    const first = await adapter.createChildIssue(child("Same"));
    const second = await adapter.createChildIssue(child("Same"));
    expect(second.number).toBe(first.number);
    expect(github.issues).toHaveLength(1);
  });

  test("different titles under one parent create two issues", async () => {
    const github = new FakeGitHub();
    const adapter = adapterOver(github);
    const a = await adapter.createChildIssue(child("A"));
    const b = await adapter.createChildIssue(child("B"));
    expect(a.number).not.toBe(b.number);
    expect(github.issues).toHaveLength(2);
  });

  test("same title with different child-create markers creates two issues; same marker returns the first", async () => {
    const github = new FakeGitHub();
    const adapter = adapterOver(github);
    const marked = (hex: string) => ({ ...child("Same title"), body: `body\n\n<!-- conveyor:child-create:${hex.repeat(64)} -->` });
    const a = await adapter.createChildIssue(marked("a"));
    const b = await adapter.createChildIssue(marked("b"));
    const again = await adapter.createChildIssue(marked("a"));
    expect(b.number).not.toBe(a.number);
    expect(again.number).toBe(a.number);
    expect(github.issues).toHaveLength(2);
  });

  test("a body with its own child-create marker is created unchanged, so a managed section can be written against it", async () => {
    const github = new FakeGitHub();
    const adapter = adapterOver(github);
    const sent = `body\n\n<!-- conveyor:child-create:${"c".repeat(64)} -->\n`;
    const created = await adapter.createChildIssue({ ...child("Kid"), body: sent });
    expect(github.issues[0]!.body).toBe(sent);
    const updated = await adapter.updateManagedSection({
      address: "o/r", issueNumber: created.number, section: "dependencies", markdown: "- #7",
      expectedRevision: adapter.managedRevision(sent), baseBody: sent,
    });
    expect(updated.body).toContain("<!-- conveyor:dependencies:start -->\n- #7\n<!-- conveyor:dependencies:end -->");
  });

  test("pull request created but answered 502 leaves a single pull request", async () => {
    const github = new FakeGitHub(true);
    const pr = await adapterOver(github).ensurePullRequest({ address: "o/r", issueNumber: 1, branch: "b", baseBranch: "main", title: "t", closingReference: true });
    expect(github.pulls).toHaveLength(1);
    expect(pr.number).toBe(1);
  });

  test("comment created but answered 502 leaves a single comment (addComment and createComment)", async () => {
    const github = new FakeGitHub(true);
    const adapter = adapterOver(github);
    const id = await adapter.addComment("o/r", 3, "hello");
    expect(github.comments).toHaveLength(1);
    expect(id).toBe(1);
    const second = new FakeGitHub(true);
    const made = await adapterOver(second).createComment("o/r", 3, "hello");
    expect(second.comments).toHaveLength(1);
    expect(made.id).toBe(1);
  });

  test("the marker is an HTML comment appended to the created body", async () => {
    const github = new FakeGitHub();
    const adapter = adapterOver(github);
    await adapter.createChildIssue(child("M"));
    await adapter.addComment("o/r", 3, "hello");
    expect(github.issues[0]!.body).toMatch(/^body\n\n<!-- conveyor:child-of:3:key:[a-f0-9]+ -->$/);
    expect(github.comments[0]!.body).toMatch(/^hello\n\n<!-- conveyor:comment:[-a-f0-9]+ -->$/);
  });
});
