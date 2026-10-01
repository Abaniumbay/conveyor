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

function pull(number: number, state = "open") {
  return {
    number, html_url: `https://github.com/owner/repo/pull/${number}`, state,
    merged: state === "merged", draft: true, mergeable_state: "clean",
    head: { ref: "feature", sha: "abc123" }, base: { ref: "main" },
  };
}

describe("CodeHost contract: GitHub", () => {
  test("ensures an existing change idempotently and exposes neutral metadata", async () => {
    const transport = new FakeTransport([[pull(8)], pull(8)]);
    const host = new GitHubCodeHost(new GitHubAdapter(transport, "conveyor"));

    const change = await host.ensureChange({
      address: "owner/repo", issueNumber: 12, branch: "feature", base: "main", title: "A feature", closes: true,
    });

    expect(change).toEqual({
      id: "github:owner/repo#pr-8", number: 8,
      url: "https://github.com/owner/repo/pull/8", state: "open", headSha: "abc123", draft: true, mergeable: true, mergedAt: null,
    });
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests.some((request) => request.method === "POST")).toBe(false);
  });

  test("creates with closing or related references and reads the new change", async () => {
    for (const [closes, expectedBody] of [[true, "Closes #12"], [false, "Related to #12"]] as const) {
      const transport = new FakeTransport([[], pull(9), pull(9)]);
      const host = new GitHubCodeHost(new GitHubAdapter(transport, "conveyor"));
      const change = await host.ensureChange({
        address: "owner/repo", issueNumber: 12, branch: "feature", base: "main", title: "A feature", closes,
      });
      expect(change.id).toBe("github:owner/repo#pr-9");
      expect(transport.requests[1]).toMatchObject({ method: "POST", body: { body: expectedBody } });
    }
  });

  test("squash merges successfully and preserves provider failure", async () => {
    const success = new FakeTransport([pull(8), { merged: true, sha: "merge123" }]);
    const host = new GitHubCodeHost(new GitHubAdapter(success, "conveyor"));
    await expect(host.mergeChange({ address: "owner/repo", id: "github:owner/repo#pr-8", method: "squash" }))
      .resolves.toEqual({ merged: true, sha: "merge123" });

    const failed = new FakeTransport([new Error("merge blocked")]);
    const broken = new GitHubCodeHost(new GitHubAdapter(failed, "conveyor"));
    await expect(broken.mergeChange({ address: "owner/repo", id: "github:owner/repo#pr-8", method: "squash" }))
      .rejects.toThrow("merge blocked");
  });

  test("sends the expected head SHA with the merge and reports a moved head", async () => {
    const fenced = new FakeTransport([pull(8), { merged: true, sha: "merge123" }]);
    const host = new GitHubCodeHost(new GitHubAdapter(fenced, "conveyor"));
    await host.mergeChange({ address: "owner/repo", id: "github:owner/repo#pr-8", method: "squash", expectedHeadSha: "abc123" });
    expect(fenced.requests[1]).toMatchObject({ method: "PUT", body: { merge_method: "squash", sha: "abc123" } });

    const moved = new FakeTransport([pull(8), new GitHubTransportError("gh failed", 1, "gh: Head branch was modified. Review and try the merge again. (HTTP 409)")]);
    const movedHost = new GitHubCodeHost(new GitHubAdapter(moved, "conveyor"));
    await expect(movedHost.mergeChange({ address: "owner/repo", id: "github:owner/repo#pr-8", method: "squash", expectedHeadSha: "abc123" }))
      .resolves.toEqual({ merged: false, headMoved: true });
  });

  test("maps GitHub mergeable_state to mergeable true, false or unknown (null)", async () => {
    const expected: Array<[string | undefined, boolean | null]> = [
      ["clean", true], ["has_hooks", true], ["unstable", true], ["dirty", false],
      ["blocked", null], ["behind", null], ["unknown", null], ["draft", null], [undefined, null],
    ];
    for (const [state, mergeable] of expected) {
      const raw = { ...pull(8), mergeable_state: state };
      const viaChange = new GitHubCodeHost(new GitHubAdapter(new FakeTransport([raw]), "conveyor"));
      expect((await viaChange.getChange({ address: "owner/repo", id: "github:owner/repo#pr-8" })).mergeable).toBe(mergeable);
      const viaDelivery = new GitHubCodeHost(new GitHubAdapter(new FakeTransport([raw, { check_runs: [] }]), "conveyor"));
      expect((await viaDelivery.getChangeDelivery({ address: "owner/repo", id: "github:owner/repo#pr-8" })).change.mergeable).toBe(mergeable);
    }
  });
});
