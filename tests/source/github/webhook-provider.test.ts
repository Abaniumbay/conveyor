import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { GitHubWebhookProvider } from "../../../src/source/github/webhook-provider";
import type { ProviderEvent } from "../../../src/app/provider-event";

const sha = "a".repeat(40);

function signed(provider: GitHubWebhookProvider, eventType: string, payload: unknown, deliveryId: string = randomUUID()) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
  return provider.receive(body, new Headers({
    "x-hub-signature-256": signature,
    "x-github-delivery": deliveryId,
    "x-github-event": eventType,
  }));
}

function providerFixture() {
  const deliveries = new Set<string>();
  const recorded: unknown[] = [];
  const provider = new GitHubWebhookProvider({
    recordSourceEvent(event: { source: string; deliveryId: string; eventType: string; payload: unknown }) {
      recorded.push(event);
      if (deliveries.has(event.deliveryId)) return false;
      deliveries.add(event.deliveryId);
      return true;
    },
  } as never, [{ id: "repo", address: "Owner/Repo" }], () => "secret");
  return { provider, recorded };
}

function payload(extra: Record<string, unknown> = {}) {
  return { repository: { full_name: "owner/repo" }, ...extra };
}

describe("GitHub webhook event provider", () => {
  test("exposes the configured provider endpoint path", () => {
    const { provider } = providerFixture();
    expect(provider.webhookPath).toBe("/hooks/github");
    const custom = new GitHubWebhookProvider({ recordSourceEvent: () => true } as never, [], () => "secret", "/hooks/custom");
    expect(custom.webhookPath).toBe("/hooks/custom");
  });

  test("maps completed and nonterminal CI, pull request sync, and issue events", async () => {
    const { provider } = providerFixture();
    const cases: Array<[string, unknown, ProviderEvent[]]> = [
      ["workflow_run", payload({ action: "completed", workflow_run: { status: "completed", head_sha: sha } }), [{ type: "ci.completed", repositoryId: "repo", commitSha: sha }]],
      ["check_suite", payload({ action: "completed", check_suite: { status: "completed", head_sha: sha } }), [{ type: "ci.completed", repositoryId: "repo", commitSha: sha }]],
      ["workflow_run", payload({ action: "in_progress", workflow_run: { status: "in_progress", head_sha: sha } }), [{ type: "ci.updated", repositoryId: "repo", commitSha: sha }]],
      ["pull_request", payload({ action: "synchronize", pull_request: { number: 8, head: { sha } } }), [{ type: "change.updated", repositoryId: "repo", changeRef: "8", headSha: sha }]],
      ["issues", payload({ issue: { number: 1 } }), [{ type: "issue.changed", repositoryId: "repo", issueRef: "1" }]],
      ["issue_comment", payload({ issue: { number: 2 } }), [{ type: "issue.changed", repositoryId: "repo", issueRef: "2" }]],
      ["issue_dependencies", payload({ issue: { number: 3 } }), [{ type: "issue.changed", repositoryId: "repo", issueRef: "3" }]],
      ["sub_issues", payload({ parent_issue: { number: 4 } }), [{ type: "issue.changed", repositoryId: "repo", issueRef: "4" }]],
    ];
    for (const [eventType, body, expected] of cases) {
      await expect(signed(provider, eventType, body)).resolves.toEqual(expected);
    }
  });

  test("rejects invalid signatures, deduplicates accepted deliveries, and records ignored events", async () => {
    const { provider, recorded } = providerFixture();
    const body = payload({ action: "completed", workflow_run: { status: "completed", head_sha: sha } });
    await expect(signed(provider, "workflow_run", body, "delivery-1")).resolves.toHaveLength(1);
    await expect(signed(provider, "workflow_run", body, "delivery-1")).resolves.toEqual([]);
    await expect(signed(provider, "deployment_status", payload(), "delivery-2")).resolves.toEqual([]);
    expect(recorded).toHaveLength(3);

    const invalidBody = new TextEncoder().encode(JSON.stringify(body));
    await expect(provider.receive(invalidBody, new Headers({
      "x-hub-signature-256": "sha256=bad",
      "x-github-delivery": "delivery-3",
      "x-github-event": "workflow_run",
    }))).rejects.toThrow("invalid GitHub webhook signature");
    expect(recorded).toHaveLength(3);
  });

  test("ignores unconfigured repositories and malformed references without waking work", async () => {
    const { provider, recorded } = providerFixture();
    await expect(signed(provider, "workflow_run", payload({
      workflow_run: { status: "completed", head_sha: "short" },
    }))).resolves.toEqual([]);
    await expect(signed(provider, "pull_request", payload({
      action: "synchronize", pull_request: { number: 1, head: { sha: "short" } },
    }))).resolves.toEqual([]);
    await expect(signed(provider, "issues", {
      repository: { full_name: "elsewhere/repo" }, issue: { number: 1 },
    })).resolves.toEqual([]);
    await expect(signed(provider, "issues", payload({ issue: {} }))).resolves.toEqual([]);
    await expect(signed(provider, "issues", payload({ issue: { number: "not-a-number" } }))).resolves.toEqual([]);
    expect(recorded).toHaveLength(5);
  });
});
