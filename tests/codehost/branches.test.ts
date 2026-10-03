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

const host = (responses: unknown[]) => {
  const transport = new FakeTransport(responses);
  return { transport, host: new GitHubCodeHost(new GitHubAdapter(transport, "conveyor")) };
};

describe("GitHub branch deletion", () => {
  test("deletes the branch ref when no open pull request uses it", async () => {
    const { transport, host: h } = host([[], {}]);
    expect(await h.deleteBranch({ address: "o/r", branch: "conveyor/7-r1-fix" })).toBe("deleted");
    expect(transport.requests[0]).toMatchObject({ method: "GET", path: "repos/o/r/pulls?state=open&head=o%3Aconveyor%2F7-r1-fix" });
    expect(transport.requests[1]).toMatchObject({ method: "DELETE", path: "repos/o/r/git/refs/heads/conveyor/7-r1-fix" });
  });

  test("keeps a branch an open pull request still uses", async () => {
    const { transport, host: h } = host([[{ number: 3 }]]);
    expect(await h.deleteBranch({ address: "o/r", branch: "conveyor/7" })).toBe("kept");
    expect(transport.requests).toHaveLength(1);
  });

  test("a branch that is already gone is absent; other errors are thrown", async () => {
    const gone = host([[], new GitHubTransportError("gh failed", 1, "gh: Reference does not exist (HTTP 422)")]);
    expect(await gone.host.deleteBranch({ address: "o/r", branch: "conveyor/7" })).toBe("absent");
    const broken = host([[], new GitHubTransportError("gh failed", 1, "gh: Server Error (HTTP 500)")]);
    await expect(broken.host.deleteBranch({ address: "o/r", branch: "conveyor/7" })).rejects.toBeInstanceOf(GitHubTransportError);
  });
});
