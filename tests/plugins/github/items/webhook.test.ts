import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import type { ConveyorConfig } from "../../../../src/config/load";
import { pluginContext } from "../../../../src/core/plugins";
import { githubClient } from "../../../../src/plugins/github/shared/client";
import { CallMeter } from "../../../../src/source/calls";
import type { GitHubAdapter } from "../../../../src/plugins/github/shared/adapter";
import { githubWebhookReceiver } from "../../../../src/plugins/github/items/webhook";

const config = {
  repositories: { app: { address: "Owner/My-App" } },
  labels: { enrollment: "conveyor" },
  sources: {
    github: { type: "github", webhookPath: "/hooks/github", autoConfigureWebhook: true, webhookSecret: "s3cret" },
    quiet: { type: "github" },
  },
} as unknown as ConveyorConfig;

function receiver(applied: Array<[string, unknown]> = []) {
  const context = pluginContext(config);
  const adapter = { applyDelivery: (eventType: string, payload: unknown) => { applied.push([eventType, payload]); } } as unknown as GitHubAdapter;
  githubClient(context, () => ({ adapter, calls: new CallMeter() }));
  return githubWebhookReceiver(context);
}

function request(eventType: string, payload: unknown, secret = "s3cret", deliveryId = "delivery-1") {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return { body, headers: new Headers({ "x-hub-signature-256": signature, "x-github-delivery": deliveryId, "x-github-event": eventType }) };
}

const issue = { id: 5, number: 12, html_url: "https://example.com/12", title: "Plan", body: "Body", state: "open", labels: [{ name: "conveyor" }], updated_at: "2026-11-12T00:00:00Z" };

describe("githubWebhookReceiver", () => {
  test("refuses a delivery no candidate secret signed", () => {
    const { body, headers } = request("ping", { repository: { full_name: "owner/my-app" } }, "someone-else");
    expect(() => receiver().receive(body, headers, ["s3cret"])).toThrow("invalid GitHub webhook signature");
  });

  test("refuses a signed delivery without GitHub's delivery headers", () => {
    const { body, headers } = request("ping", { repository: { full_name: "owner/my-app" } });
    headers.delete("x-github-delivery");
    expect(() => receiver().receive(body, headers, ["s3cret"])).toThrow("missing GitHub webhook headers");
  });

  test("ignores Conveyor's own status comment coming back", () => {
    const { body, headers } = request("issue_comment", { action: "edited", repository: { full_name: "owner/my-app" }, issue: { number: 1 }, comment: { body: "<!-- conveyor:status -->" } });
    expect(receiver().receive(body, headers, ["s3cret"])).toEqual({ kind: "ignored" });
  });

  test("reads an issue delivery into an observation carrying the issue under the configured address", () => {
    const { body, headers } = request("issues", { action: "labeled", repository: { full_name: "owner/my-app" }, issue, label: { name: "conveyor" }, sender: { login: "owner" } });
    const receipt = receiver().receive(body, headers, ["other", "s3cret"]);
    expect(receipt.kind).toBe("delivery");
    if (receipt.kind !== "delivery") return;
    expect(receipt.secret).toBe("s3cret");
    expect(receipt.delivery).toMatchObject({ deliveryId: "delivery-1", eventType: "issues", repositoryAddress: "owner/my-app" });
    expect(receipt.delivery.observations).toEqual([{
      type: "itemSource.itemChanged",
      payload: expect.objectContaining({ number: 12, item: expect.objectContaining({ id: "github:Owner/My-App#12", title: "Plan" }) }),
    }]);
  });

  test("updates GitHub's cached copy only once the delivery was recorded", () => {
    const applied: Array<[string, unknown]> = [];
    const { body, headers } = request("ping", { repository: { full_name: "owner/my-app" } });
    const receipt = receiver(applied).receive(body, headers, ["s3cret"]);
    expect(applied).toEqual([]);
    if (receipt.kind === "delivery") receipt.delivery.recorded?.();
    expect(applied.map(([eventType]) => eventType)).toEqual(["ping"]);
  });

  test("reads each item source's webhook settings from its own configuration", () => {
    expect(receiver().settings("github")).toEqual({ path: "/hooks/github", secret: "s3cret", managed: true });
  });

  test("falls back to the defaults and CONVEYOR_GITHUB_WEBHOOK_SECRET for a source that sets neither", () => {
    const previous = process.env.CONVEYOR_GITHUB_WEBHOOK_SECRET;
    process.env.CONVEYOR_GITHUB_WEBHOOK_SECRET = "from-the-environment";
    try {
      expect(receiver().settings("quiet")).toEqual({ path: "/hooks/github", secret: "from-the-environment", managed: false });
    } finally {
      if (previous === undefined) delete process.env.CONVEYOR_GITHUB_WEBHOOK_SECRET;
      else process.env.CONVEYOR_GITHUB_WEBHOOK_SECRET = previous;
    }
  });
});
