import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { ConveyorService } from "../../src/app/service";
import type { CiProvider } from "../../src/app/ci-provider";
import type { RuntimeIssueContext, ScopedMcpFactory } from "../../src/app/runtime";
import type { GitHubAdapter, GitHubCheckRun, GitHubDeliveryState } from "../../src/source/github/adapter";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-delivery-service-"));
  directories.push(root);
  const repositoryFolder = path.join(root, "repository");
  await mkdir(repositoryFolder);
  await writeFile(path.join(root, "agent.md"), "Work.");
  await writeFile(path.join(root, "config.yml"), `
settings:
  database: ${root}/db.sqlite
  logs: ${root}/logs
  workspaces: ${root}/workspaces
  artifacts: ${root}/artifacts
web: {}
sources:
  github: { type: github }
runners:
  codex: { type: codex, command: codex }
agents:
  worker:
    runner: codex
    instructions: ./agent.md
    tools: [delivery.get_state, delivery.get_check_logs]
checks: {}
ci:
  actions:
    type: github-actions
    triggers: [{ label: unrelated, workflow: unrelated.yml, check: Unrelated }]
labels:
  enrollment: conveyor
  stageTemplate: "conveyor:{stage}"
  states: { done: "conveyor:done", blocked: "conveyor:blocked" }
  metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" }
pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked]
    stages:
      - id: implementation
        run: { agent: worker }
        concurrency: 1
repositories:
  repo:
    source: github
    address: owner/repo
    folder: ${repositoryFolder}
    pipeline: default
`);
  const config = await loadConfig(path.join(root, "config.yml"));
  const store = await ConveyorStore.open(config.settings.database);
  store.upsertRepository({
    id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: repositoryFolder, configHash: config.hash,
  });
  store.upsertIssue({
    id: "issue", repositoryId: "repo", sourceNumber: 1, sourceUrl: "https://github.com/owner/repo/issues/1",
    title: "Feature", body: "", sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  store.activateEnrollment("issue");
  store.upsertPullRequest({ issueId: "issue", id: "pr-1", number: 9, url: "https://github.com/owner/repo/pull/9", state: "open" });

  const rawRuns: GitHubCheckRun[] = [
    { id: 10, name: "External", status: "completed", conclusion: "failure", details_url: "https://checks/external", started_at: null, completed_at: null, app: null },
    { id: 11, name: "Actions failed", status: "completed", conclusion: "failure", details_url: "https://checks/failed", started_at: null, completed_at: null, app: { slug: "github-actions" } },
    { id: 12, name: "Actions cancelled", status: "completed", conclusion: "cancelled", details_url: "https://checks/cancelled", started_at: null, completed_at: null, app: { slug: "github-actions" } },
    { id: 13, name: "Passing", status: "completed", conclusion: "success", details_url: "https://checks/passing", started_at: null, completed_at: null, app: { slug: "github-actions" } },
  ];
  const logCalls: string[] = [];
  const workflowCalls: string[] = [];
  const retriggerCalls: string[] = [];
  const delivery: GitHubDeliveryState = {
    pullRequest: {
      number: 9, url: "https://github.com/owner/repo/pull/9", state: "open", merged: false,
      mergedAt: null, mergeCommitSha: null, draft: false, mergeState: "clean",
      headBranch: "feature", headSha: "abc123", baseBranch: "main",
    },
    checks: [],
  };
  const github = {
    async getPullRequestDelivery() { return delivery; },
    async getPullRequestChange() {
      return {
        number: 9, url: "https://github.com/owner/repo/pull/9", state: "open",
        draft: false, mergeState: "clean", headSha: "abc123", mergedAt: null,
      };
    },
    async getPullRequestHead() { return { sha: "abc123" }; },
    async listCheckRuns() { return rawRuns; },
    async jobLog(_address: string, id: number) { logCalls.push(String(id)); return `log-${id}`; },
    async workflowExists(_address: string, workflow: string) { workflowCalls.push(workflow); return true; },
    async retriggerLabel(_address: string, _number: number, label: string) { retriggerCalls.push(label); },
  } as unknown as GitHubAdapter;
  const service = new ConveyorService(config, store, github);
  const issue = store.getIssue("issue")!;
  const context: RuntimeIssueContext = {
    issue,
    repository: { id: "repo", address: "owner/repo", folder: repositoryFolder, baseBranch: "main" },
    workspace: null,
    sourceGuidance: "",
  };
  const factory = (service as unknown as { mcpFactory(): ScopedMcpFactory }).mcpFactory();
  const lease = await factory.create({
    runId: "run-1", stageId: "implementation", context,
    allowedTools: ["delivery.get_state", "delivery.get_check_logs"],
    actor: { id: "worker", name: "Worker", title: "Engineer" },
  });
  const token = JSON.parse(await Bun.file(path.join(root, "artifacts/run-1/mcp-context.json")).text()).control.token as string;

  return {
    store,
    service,
    token,
    logCalls,
    workflowCalls,
    retriggerCalls,
    async close() { await lease.close(); store.close(); },
  };
}

describe("service delivery tools", () => {
  test("uses native CI when an unreferenced named provider exists, retaining legacy stage triggers", async () => {
    const fixture = await setup();
    try {
      const service = fixture.service as unknown as {
        ciProvider(repositoryId: string, stageInput?: Record<string, unknown>): CiProvider;
      };
      const change = { repository: "owner/repo", changeId: "9", url: "https://github.com/owner/repo/pull/9" };
      const native = service.ciProvider("repo");
      await expect(native.start(change, "abc123", 60_000, 10_000)).resolves.toEqual([]);
      expect(fixture.workflowCalls).toEqual([]);
      expect(fixture.retriggerCalls).toEqual([]);

      const legacy = service.ciProvider("repo", {
        triggers: [{ label: "legacy", workflow: "legacy.yml", check: "Legacy" }],
      });
      await expect(legacy.start(change, "abc123", 60_000, 10_000)).resolves.toEqual(["Legacy"]);
      expect(fixture.workflowCalls).toEqual(["legacy.yml"]);
      expect(fixture.retriggerCalls).toEqual(["legacy"]);
    } finally {
      await fixture.close();
    }
  });

  test("returns neutral CI run fields from the selected provider", async () => {
    const fixture = await setup();
    try {
      const result = await fixture.service.handleMcp({ tool: "delivery.get_state", input: {} }, fixture.token) as {
        pullRequest: { number: number; headSha: string };
        checks: Array<Record<string, unknown>>;
      };

      expect(result.pullRequest).toMatchObject({ number: 9, url: "https://github.com/owner/repo/pull/9", headSha: "abc123" });
      expect(result.checks).toContainEqual({
        id: "10", name: "External", url: "https://checks/external", state: "failed", canRerun: false, hasLog: false,
      });
      expect(result.checks).toContainEqual({
        id: "11", name: "Actions failed", url: "https://checks/failed", state: "failed", canRerun: true, hasLog: true,
      });
    } finally {
      await fixture.close();
    }
  });

  test("named and default log selection honor provider capabilities and retain pull request metadata", async () => {
    const fixture = await setup();
    try {
      const named = await fixture.service.handleMcp({
        tool: "delivery.get_check_logs", input: { checkName: "External" },
      }, fixture.token) as { pullRequest: { number: number; url: string; headSha: string }; checks: Array<Record<string, unknown>> };
      expect(named.pullRequest).toEqual({ number: 9, url: "https://github.com/owner/repo/pull/9", headSha: "abc123" });
      expect(named.checks).toEqual([{
        id: "10", name: "External", url: "https://checks/external", state: "failed", canRerun: false, hasLog: false, log: null,
      }]);
      expect(fixture.logCalls).toEqual([]);

      const defaults = await fixture.service.handleMcp({ tool: "delivery.get_check_logs", input: {} }, fixture.token) as {
        pullRequest: { number: number; url: string; headSha: string };
        checks: Array<Record<string, unknown>>;
      };
      expect(defaults.pullRequest).toEqual(named.pullRequest);
      expect(defaults.checks.map((check) => check.name)).toEqual(["Actions cancelled", "Actions failed", "External"]);
      expect(defaults.checks.find((check) => check.name === "External")?.log).toBeNull();
      expect(defaults.checks.find((check) => check.name === "Actions failed")?.log).toBe("log-11");
      expect(fixture.logCalls).toEqual(["12", "11"]);
    } finally {
      await fixture.close();
    }
  });
});
