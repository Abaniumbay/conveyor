import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import {
  GitHubAdapter,
  verifyGitHubSignature,
  type GitHubTransport,
  type GitHubTransportRequest,
} from "../../../src/source/github/adapter";

class FakeTransport implements GitHubTransport {
  readonly requests: GitHubTransportRequest[] = [];
  readonly #responses: unknown[];

  constructor(...responses: unknown[]) {
    this.#responses = [...responses];
  }

  async request<T>(request: GitHubTransportRequest): Promise<T> {
    this.requests.push(request);
    if (this.#responses.length === 0) throw new Error("unexpected GitHub request");
    return this.#responses.shift() as T;
  }
}

describe("GitHubAdapter", () => {
  test("projects only issues carrying the configured Conveyor prefix", async () => {
    const transport = new FakeTransport([
      {
        id: 101,
        number: 1,
        html_url: "https://github.com/owner/repo/issues/1",
        title: "Active",
        body: "body",
        state: "open",
        state_reason: null,
        labels: [{ name: "conveyor" }, { name: "backend" }],
        updated_at: "2026-01-01T00:00:00Z",
      },
      {
        id: 102,
        number: 2,
        html_url: "https://github.com/owner/repo/issues/2",
        title: "Paused",
        body: null,
        state: "open",
        state_reason: null,
        labels: [{ name: "conveyor:implementation" }],
        updated_at: "2026-01-02T00:00:00Z",
      },
      {
        id: 103,
        number: 3,
        html_url: "https://github.com/owner/repo/issues/3",
        title: "Invisible",
        body: "",
        state: "open",
        labels: [{ name: "backend" }],
        updated_at: "2026-01-03T00:00:00Z",
      },
      {
        id: 104,
        number: 4,
        html_url: "https://github.com/owner/repo/pull/4",
        title: "A pull request",
        body: "",
        state: "open",
        labels: [{ name: "conveyor" }],
        pull_request: {},
        updated_at: "2026-01-04T00:00:00Z",
      },
    ]);
    const adapter = new GitHubAdapter(transport, "conveyor");

    const issues = await adapter.listConveyorIssues("owner/repo");

    expect(issues.map((issue) => issue.number)).toEqual([1, 2]);
    expect(issues[1]).toMatchObject({ body: "", labels: ["conveyor:implementation"] });
    expect(transport.requests[0]).toMatchObject({ method: "GET", paginate: true });
  });

  test("projects GitHub's close reason separately from issue state", async () => {
    const transport = new FakeTransport([{
      id: 105,
      number: 5,
      html_url: "https://github.com/owner/repo/issues/5",
      title: "Delivered",
      body: "",
      state: "closed",
      state_reason: "completed",
      labels: [{ name: "conveyor:done" }],
      updated_at: "2026-01-05T00:00:00Z",
    }]);
    const adapter = new GitHubAdapter(transport, "conveyor");

    expect(await adapter.listConveyorIssues("owner/repo")).toEqual([
      expect.objectContaining({ state: "closed", stateReason: "completed" }),
    ]);
  });

  test("can list all source issues so reconciliation observes full offboarding", async () => {
    const transport = new FakeTransport([
      {
        id: 101,
        number: 1,
        html_url: "https://github.com/owner/repo/issues/1",
        title: "Offboarded",
        body: "body",
        state: "open",
        labels: [{ name: "backend" }],
        updated_at: "2026-01-01T00:00:00Z",
      },
    ]);
    const adapter = new GitHubAdapter(transport, "conveyor");

    expect(await adapter.listIssues("owner/repo")).toEqual([
      expect.objectContaining({ number: 1, labels: ["backend"] }),
    ]);
  });

  test("replaces only Conveyor labels while preserving project labels", async () => {
    const transport = new FakeTransport(
      {
        labels: [
          { name: "backend" },
          { name: "conveyor" },
          { name: "conveyor:refinement" },
        ],
      },
      [{ name: "backend" }, { name: "conveyor" }, { name: "conveyor:implementation" }],
    );
    const adapter = new GitHubAdapter(transport, "conveyor");

    await adapter.replaceConveyorLabels("owner/repo", 7, [
      "conveyor",
      "conveyor:implementation",
    ]);

    expect(transport.requests[1]).toEqual({
      method: "PUT",
      path: "repos/owner/repo/issues/7/labels",
      body: {
        labels: ["backend", "conveyor", "conveyor:implementation"],
      },
    });
  });

  test("replaces configured system labels while preserving workflow and unmanaged labels", async () => {
    const transport = new FakeTransport(
      {
        labels: [
          { name: "conveyor" },
          { name: "conveyor:refinement" },
          { name: "backend" },
          { name: "priority:high" },
        ],
      },
      {},
    );
    const adapter = new GitHubAdapter(transport, "conveyor");

    await adapter.replaceManagedProjectLabels(
      "owner/repo",
      7,
      ["backend", "web", "mobile"],
      ["web"],
    );

    expect(transport.requests[1]).toEqual({
      method: "PUT",
      path: "repos/owner/repo/issues/7/labels",
      body: {
        labels: ["conveyor", "conveyor:refinement", "priority:high", "web"],
      },
    });
  });

  test("updates the marked status comment instead of creating conversation spam", async () => {
    const transport = new FakeTransport(
      [
        { id: 55, body: "<!-- conveyor:status -->\nOld" },
        { id: 56, body: "Human comment" },
      ],
      { id: 55, body: "updated" },
    );
    const adapter = new GitHubAdapter(transport, "conveyor");

    const id = await adapter.upsertStatusComment("owner/repo", 3, "Current status");

    expect(id).toBe(55);
    expect(transport.requests[1]).toEqual({
      method: "PATCH",
      path: "repos/owner/repo/issues/comments/55",
      body: { body: "<!-- conveyor:status -->\nCurrent status" },
    });
  });

  test("optimistically updates only a managed issue-body section", async () => {
    const body = "Human text";
    const updatedBody = `${body}\n\n<!-- conveyor:acceptance-criteria:start -->\n- [ ] Works <!-- conveyor:criterion:AC-1 -->\n<!-- conveyor:acceptance-criteria:end -->\n`;
    const issue = {
      id: 101,
      number: 3,
      html_url: "https://github.com/owner/repo/issues/3",
      title: "Feature",
      body,
      state: "open" as const,
      labels: [{ name: "conveyor" }],
      updated_at: "2026-01-01T00:00:00Z",
    };
    const transport = new FakeTransport(
      issue,
      { ...issue, body: updatedBody, updated_at: "2026-01-02T00:00:00Z" },
    );
    const adapter = new GitHubAdapter(transport, "conveyor");

    const updated = await adapter.updateManagedSection({
      address: "owner/repo",
      issueNumber: 3,
      section: "acceptance-criteria",
      markdown: "- [ ] Works <!-- conveyor:criterion:AC-1 -->",
      expectedRevision: adapter.managedRevision(body),
    });

    expect(transport.requests[1]).toEqual({
      method: "PATCH",
      path: "repos/owner/repo/issues/3",
      body: { body: updatedBody },
    });
    expect(updated.body).toBe(updatedBody);
  });

  test("creates a PR idempotently and requests squash merge", async () => {
    const transport = new FakeTransport(
      [],
      { number: 18, html_url: "https://github.com/owner/repo/pull/18", state: "open" },
      { merged: true, sha: "abc123" },
    );
    const adapter = new GitHubAdapter(transport, "conveyor");

    const pullRequest = await adapter.ensurePullRequest({
      address: "owner/repo",
      issueNumber: 12,
      branch: "conveyor/12-r1-feature",
      baseBranch: "main",
      title: "Deliver feature",
      closingReference: true,
    });
    const merge = await adapter.squashMerge("owner/repo", pullRequest.number);

    expect(transport.requests[1]).toMatchObject({
      method: "POST",
      body: {
        head: "conveyor/12-r1-feature",
        base: "main",
        body: "Closes #12",
      },
    });
    expect(transport.requests[2]).toEqual({
      method: "PUT",
      path: "repos/owner/repo/pulls/18/merge",
      body: { merge_method: "squash" },
    });
    expect(merge).toEqual({ merged: true, sha: "abc123" });
  });

  test("loads a pull request and its current check runs for delivery gates", async () => {
    const transport = new FakeTransport(
      {
        number: 18,
        html_url: "https://github.com/owner/repo/pull/18",
        state: "open",
        draft: false,
        mergeable_state: "clean",
        head: { ref: "conveyor/12-r1-feature", sha: "abc123" },
        base: { ref: "main" },
      },
      {
        check_runs: [
          {
            id: 91,
            name: "Tests",
            status: "completed",
            conclusion: "success",
            details_url: "https://github.com/owner/repo/actions/runs/1",
            started_at: "2026-09-29T12:00:00Z",
            completed_at: "2026-09-29T12:05:00Z",
          },
        ],
      },
    );
    const adapter = new GitHubAdapter(transport, "conveyor");

    await expect(adapter.getPullRequestDelivery("owner/repo", 18)).resolves.toEqual({
      pullRequest: {
        number: 18,
        url: "https://github.com/owner/repo/pull/18",
        state: "open",
        draft: false,
        mergeState: "clean",
        headBranch: "conveyor/12-r1-feature",
        headSha: "abc123",
        baseBranch: "main",
      },
      checks: [{
        id: 91,
        name: "Tests",
        status: "completed",
        conclusion: "success",
        url: "https://github.com/owner/repo/actions/runs/1",
        startedAt: "2026-09-29T12:00:00Z",
        completedAt: "2026-09-29T12:05:00Z",
      }],
    });
    expect(transport.requests).toEqual([
      { method: "GET", path: "repos/owner/repo/pulls/18" },
      { method: "GET", path: "repos/owner/repo/commits/abc123/check-runs?per_page=100" },
    ]);
  });

  test("reads native child and dependency relationships", async () => {
    const related = {
      id: 12,
      number: 12,
      html_url: "https://github.com/owner/repo/issues/12",
      title: "Related",
      body: "",
      state: "open" as const,
      labels: [{ name: "conveyor" }],
      updated_at: "2026-01-01T00:00:00Z",
    };
    const transport = new FakeTransport([related], [related]);
    const adapter = new GitHubAdapter(transport, "conveyor");

    expect((await adapter.listSubIssues("owner/repo", 1))[0]?.number).toBe(12);
    expect((await adapter.listDependencies("owner/repo", 2))[0]?.number).toBe(12);
    expect(transport.requests.map((request) => request.path)).toEqual([
      "repos/owner/repo/issues/1/sub_issues?per_page=100",
      "repos/owner/repo/issues/2/dependencies/blocked_by?per_page=100",
    ]);
  });

  test("creates only missing configured labels during onboarding", async () => {
    const transport = new FakeTransport(
      [{ name: "conveyor" }],
      { name: "conveyor:done" },
    );
    const adapter = new GitHubAdapter(transport, "conveyor");

    await adapter.ensureLabels("owner/repo", [
      { name: "conveyor", color: "2563eb", description: "Managed by Conveyor" },
      { name: "conveyor:done", color: "16a34a", description: "Delivery complete" },
    ]);

    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]).toEqual({
      method: "POST",
      path: "repos/owner/repo/labels",
      body: {
        name: "conveyor:done",
        color: "16a34a",
        description: "Delivery complete",
      },
    });
  });

  test("installs a signed webhook when no matching hook exists", async () => {
    const transport = new FakeTransport(
      [],
      { id: 4, config: { url: "https://example.test/hooks/github" }, active: true },
    );
    const adapter = new GitHubAdapter(transport, "conveyor");

    await adapter.ensureWebhook({
      address: "owner/repo",
      url: "https://example.test/hooks/github",
      secret: "webhook-secret",
    });

    expect(transport.requests[1]).toEqual({
      method: "POST",
      path: "repos/owner/repo/hooks",
      body: {
        name: "web",
        active: true,
        events: [
          "issues",
          "issue_comment",
          "pull_request",
          "workflow_run",
          "deployment_status",
          "sub_issues",
          "issue_dependencies",
        ],
        config: {
          url: "https://example.test/hooks/github",
          content_type: "json",
          insecure_ssl: "0",
          secret: "webhook-secret",
        },
      },
    });
  });
});

describe("verifyGitHubSignature", () => {
  test("accepts only the matching sha256 signature", () => {
    const body = new TextEncoder().encode('{"action":"labeled"}');
    const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;

    expect(verifyGitHubSignature(body, signature, "secret")).toBe(true);
    expect(verifyGitHubSignature(body, "sha256=deadbeef", "secret")).toBe(false);
    expect(verifyGitHubSignature(body, null, "secret")).toBe(false);
  });
});
