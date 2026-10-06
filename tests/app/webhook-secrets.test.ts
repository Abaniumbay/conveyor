import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { ConsoleSink, log } from "../../src/log/logger";

const directories: string[] = [];
afterEach(async () => {
  log.configure({ sinks: [new ConsoleSink()] });
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const LABELS = {
  enrollment: "conveyor", stageTemplate: "conveyor:{stage}",
  states: { done: "conveyor:done" }, metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" },
};

/** Two GitHub providers with their own webhook secrets, one repository each. */
async function service() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-webhook-"));
  directories.push(root);
  log.configure({ sinks: [] });
  const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
  const config = {
    hash: "h", root,
    settings: { artifacts: path.join(root, "artifacts"), workspaces: path.join(root, "worktrees"), runners: 1, labelPrefix: "conveyor" },
    web: { listen: "127.0.0.1:7788" },
    sources: {
      first: { type: "github", webhookPath: "/hooks/github", webhookSecret: "first-secret" },
      second: { type: "github", webhookPath: "/hooks/github", webhookSecret: "second-secret" },
    },
    labels: LABELS,
    pipelines: { default: { successStatuses: ["done"], failureStatuses: ["blocked"], stages: [{ id: "work", run: { type: "agent", agent: "a" }, concurrency: 1, failurePolicies: {}, afterSuccess: [] }] } },
    repositories: {
      one: { source: "first", address: "owner/one", folder: root, baseBranch: "main", pipeline: "default", concurrency: 1, systemLabels: [] },
      two: { source: "second", address: "owner/two", folder: root, baseBranch: "main", pipeline: "default", concurrency: 1, systemLabels: [] },
    },
    agents: {},
  } as unknown as ConveyorConfig;
  for (const [id, repository] of Object.entries(config.repositories)) {
    store.upsertRepository({ id, configName: id, source: repository.source, address: repository.address, folder: root, configHash: "h" });
  }
  const listed: string[] = [];
  const github = {
    async listIssues(address: string) { listed.push(address); return []; },
    async listSubIssues() { return []; }, async listDependencies() { return []; },
  };
  const conveyor = new ConveyorService(config, store, github as never);
  conveyor.drain("tests: nothing executes");
  let delivery = 0;
  const deliver = (repository: string, secret: string, id = `d${(delivery += 1)}`) => {
    const body = new TextEncoder().encode(JSON.stringify({ repository: { full_name: repository } }));
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    return conveyor.handleWebhook(body, new Headers({ "x-hub-signature-256": signature, "x-github-delivery": id, "x-github-event": "issues" }));
  };
  return { conveyor, store, listed, deliver };
}

describe("GitHub webhooks with a secret per provider", () => {
  test("a delivery signed with its repository's provider secret is accepted, whichever provider that is", async () => {
    const { listed, deliver, store } = await service();
    await deliver("owner/two", "second-secret");
    await deliver("owner/one", "first-secret");
    expect(listed).toEqual(["owner/two", "owner/one"]);
    store.close();
  });

  test("a secret of another provider, or an unknown one, is refused and nothing is recorded or reconciled", async () => {
    const { listed, deliver, store } = await service();
    await expect(deliver("owner/two", "first-secret", "retried")).rejects.toThrow("invalid GitHub webhook signature for this repository");
    await expect(deliver("owner/one", "nobody's-secret")).rejects.toThrow("invalid GitHub webhook signature");
    expect(listed).toEqual([]);
    // The refused delivery id was not recorded, so a correctly signed retry of it is processed.
    await expect(deliver("owner/two", "second-secret", "retried")).resolves.toBeUndefined();
    expect(listed).toEqual(["owner/two"]);
    store.close();
  });
});
