import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import { ConfiguredStageRuntime, type RuntimeIssueContext, type SourceActionHandler } from "../../src/app/runtime";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { migrations } from "../../src/db/migrations";
import { GitHubAdapter, type GitHubTransport } from "../../src/source/github/adapter";

const roots: string[] = [];
const requestLog: Array<Record<string, unknown>> = [];

afterEach(async () => {
  requestLog.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function command(cwd: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${stderr}`);
}

async function setup(options: { legacyDatabase?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-codehost-service-"));
  roots.push(root);
  const repositoryFolder = path.join(root, "repository");
  const worktree = path.join(root, "workspace");
  const database = path.join(root, "conveyor.sqlite");
  await mkdir(repositoryFolder);
  const bare = path.join(root, "origin.git");
  await command(root, "init", "--bare", bare);
  await command(worktree, "init", "-b", "conveyor/1-r1-feature").catch(async () => {
    await mkdir(worktree);
    await command(worktree, "init", "-b", "conveyor/1-r1-feature");
  });
  await command(worktree, "config", "user.email", "tests@example.test");
  await command(worktree, "config", "user.name", "Tests");
  await writeFile(path.join(worktree, "feature.txt"), "change\n");
  await command(worktree, "add", "feature.txt");
  await command(worktree, "commit", "-m", "feature");
  await command(worktree, "remote", "add", "origin", bare);

  if (options.legacyDatabase) {
    const legacy = new Database(database, { create: true });
    legacy.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const migration of migrations) {
      legacy.exec(migration.sql);
      legacy.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, "2026-01-01T00:00:00.000Z");
    }
    legacy.exec(`
      INSERT INTO repositories(id, config_name, source, address, folder, config_hash, created_at, updated_at)
      VALUES ('repo', 'repo', 'github', 'owner/repo', '${repositoryFolder}', 'hash', '2026-01-01', '2026-01-01');
      INSERT INTO issues(id, repository_id, source_number, source_url, title, body, source_state, labels_json, source_updated_at, created_at, updated_at)
      VALUES ('issue', 'repo', 1, 'https://github.com/owner/repo/issues/1', 'Feature', '', 'open', '[]', '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO enrollments(id, issue_id, generation, status, started_at) VALUES ('enrollment', 'issue', 1, 'active', '2026-01-01');
      INSERT INTO pull_requests(id, enrollment_id, source_number, url, state, merged_at, updated_at)
      VALUES ('github:owner/repo#pr-23', 'enrollment', 23, 'https://github.com/owner/repo/pull/23', 'merged', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    `);
    legacy.close();
  }

  const configPath = path.join(root, "config.yml");
  await writeFile(configPath, `
settings:
  database: ${database}
  logs: ${root}/logs
  workspaces: ${root}/workspaces
  artifacts: ${root}/artifacts
web: { listen: "127.0.0.1:3456" }
sources:
  github: { type: github }
runners:
  codex: { type: codex, command: codex }
agents:
  worker: { runner: codex, instructions: ./instructions.md, tools: [] }
checks: {}
labels:
  enrollment: conveyor
  stageTemplate: "conveyor:{stage}"
  states: { done: "conveyor:done", blocked: "conveyor:blocked" }
  metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" }
pipelines:
  default:
    successStatuses: [done]
    failureStatuses: [blocked, changes-requested]
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
  await writeFile(path.join(root, "instructions.md"), "Do the work.");
  const config = await loadConfig(configPath);
  const store = await ConveyorStore.open(database);
  if (!options.legacyDatabase) {
    store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: repositoryFolder, configHash: config.hash });
    store.upsertIssue({ id: "issue", repositoryId: "repo", sourceNumber: 1, sourceUrl: "https://github.com/owner/repo/issues/1", title: "Feature", body: "", sourceState: "open", labels: [], sourceUpdatedAt: "2026-01-01" });
    store.activateEnrollment("issue");
  }

  const transport: GitHubTransport = { async request<T>() { return [] as T; } };
  const github = new GitHubAdapter(transport, "conveyor");
  let deliveryMerged = false;
  github.ensurePullRequest = async (input) => {
    requestLog.push({ op: "ensure", ...input });
    return { number: 23, url: "https://github.com/owner/repo/pull/23", state: "open" };
  };
  github.getPullRequestChange = async (_address, number) => {
    requestLog.push({ op: "change", number });
    return ({
    number, url: "https://github.com/owner/repo/pull/23", state: "open", draft: false,
    mergeState: "clean", headSha: "head-sha-23", mergedAt: null,
    });
  };
  github.squashMerge = async (_address, number) => { requestLog.push({ op: "merge", number }); return { merged: true, sha: "merge-sha" }; };
  github.getPullRequestDelivery = async (_address, number) => ({
    pullRequest: {
      number, url: `https://github.com/owner/repo/pull/${number}`, state: deliveryMerged ? "merged" : "open",
      merged: deliveryMerged, mergedAt: deliveryMerged ? "2026-01-02T00:00:00.000Z" : null,
      mergeCommitSha: null, draft: false, mergeState: "clean", headBranch: "conveyor/1-r1-feature",
      headSha: "head-sha-23", baseBranch: "main",
    },
    checks: [{ id: 7, name: "Tests", status: "completed", conclusion: "success", url: "https://checks.test/7", startedAt: null, completedAt: null }],
  });
  github.listCheckRuns = async (_address, sha) => {
    requestLog.push({ op: "checks", sha });
    return [{ id: 7, name: "Tests", status: "completed", conclusion: "success", details_url: "https://checks.test/7", started_at: null, completed_at: null, app: { slug: "github-actions" } }];
  };
  github.jobLog = async (_address, id) => { requestLog.push({ op: "log", id }); return "test failed\n"; };
  const service = new ConveyorService(config, store, github);
  const issue = store.getIssue("issue")!;
  const context: RuntimeIssueContext = {
    issue,
    repository: { id: "repo", address: "owner/repo", folder: repositoryFolder, baseBranch: "main" },
    workspace: { path: worktree, branch: "conveyor/1-r1-feature" },
    sourceGuidance: "",
  };
  return { root, config, store, service, issue, context, setDeliveryMerged(value: boolean) { deliveryMerged = value; } };
}

describe("CodeHost service integration", () => {
  for (const name of ["change.ensure", "pullRequest.ensure"]) {
    test(`${name} uses the same push, ensure, and closing reference from a source-action stage`, async () => {
      const { service, context, store } = await setup();
      const handler = (service as unknown as { sourceActions(context: RuntimeIssueContext): SourceActionHandler }).sourceActions(context);
      await handler.run({ sourceAction: name, with: { closingReference: false } }, { issue: context.issue as unknown as Record<string, unknown>, workspace: context.workspace!.path, stageId: "implementation", attempt: 1, feedback: null });
      expect(requestLog).toContainEqual(expect.objectContaining({ op: "ensure", closingReference: false, branch: "conveyor/1-r1-feature" }));
      expect(store.getCurrentPullRequest("issue")).toMatchObject({ id: "github:owner/repo#pr-23", number: 23, state: "open" });
      store.close();
    });
  }

  for (const name of ["change.ensure", "pullRequest.ensure"]) {
    test(`${name} has the same push and ensure behavior from an afterSuccess action`, async () => {
      const { service, context, config, store } = await setup();
      const handler = (service as unknown as { sourceActions(context: RuntimeIssueContext): SourceActionHandler }).sourceActions(context);
      const runtime = new ConfiguredStageRuntime(config, store, context, { async create() { throw new Error("agent not expected"); } }, handler);
      await runtime.runAction({ sourceAction: name, with: { closingReference: false } }, { issue: context.issue as unknown as Record<string, unknown>, workspace: context.workspace!.path, stageId: "implementation", attempt: 1, feedback: null, producerResult: { stageResult: { outcome: "success", status: "done", summary: "ok", reason: null, metrics: {} }, sessionId: null, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, cost: { amount: 0, currency: "USD", source: "unavailable" }, durationMs: 0, exitCode: 0, artifacts: [], stderr: "" } });
      expect(requestLog).toContainEqual(expect.objectContaining({ op: "ensure", closingReference: false, branch: "conveyor/1-r1-feature" }));
      expect(store.getCurrentPullRequest("issue")).toMatchObject({ id: "github:owner/repo#pr-23", state: "open" });
      store.close();
    });
  }

  for (const name of ["change.merge", "pullRequest.squashMerge"]) {
    test(`${name} ensures before squash merge from an afterSuccess action`, async () => {
      const { service, context, config, store } = await setup();
      const handler = (service as unknown as { sourceActions(context: RuntimeIssueContext): SourceActionHandler }).sourceActions(context);
      const runtime = new ConfiguredStageRuntime(config, store, context, { async create() { throw new Error("agent not expected"); } }, handler);
      await runtime.runAction({ sourceAction: name }, { issue: context.issue as unknown as Record<string, unknown>, workspace: context.workspace!.path, stageId: "implementation", attempt: 1, feedback: null, producerResult: { stageResult: { outcome: "success", status: "done", summary: "ok", reason: null, metrics: {} }, sessionId: null, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, cost: { amount: 0, currency: "USD", source: "unavailable" }, durationMs: 0, exitCode: 0, artifacts: [], stderr: "" } });
      expect(requestLog.map((entry) => entry.op)).toEqual(["ensure", "change", "merge"]);
      expect(store.getCurrentPullRequest("issue")).toMatchObject({ id: "github:owner/repo#pr-23", state: "merged" });
      store.close();
    });
  }

  for (const name of ["change.merge", "pullRequest.squashMerge"]) {
    test(`${name} has the same ensure-before-merge behavior from a source-action stage`, async () => {
      const { service, context, store } = await setup();
      const handler = (service as unknown as { sourceActions(context: RuntimeIssueContext): SourceActionHandler }).sourceActions(context);
      await handler.run({ sourceAction: name }, { issue: context.issue as unknown as Record<string, unknown>, workspace: context.workspace!.path, stageId: "implementation", attempt: 1, feedback: null });
      expect(requestLog.map((entry) => entry.op)).toEqual(["ensure", "change", "merge"]);
      expect(store.getCurrentPullRequest("issue")).toMatchObject({ id: "github:owner/repo#pr-23", state: "merged" });
      store.close();
    });
  }

  test("pullRequest.awaitChecks obtains the current head through CodeHost", async () => {
    const { service, context, store, setDeliveryMerged } = await setup();
    const handler = (service as unknown as { sourceActions(context: RuntimeIssueContext): SourceActionHandler }).sourceActions(context);
    await handler.run({ sourceAction: "pullRequest.awaitChecks" }, { issue: context.issue as unknown as Record<string, unknown>, workspace: context.workspace!.path, stageId: "implementation", attempt: 1, feedback: null })
      .catch((error) => expect(error).toMatchObject({ name: "ExternalWaitError" }));
    expect(requestLog).toContainEqual({ op: "change", number: 23 });
    expect(requestLog).toContainEqual({ op: "checks", sha: "head-sha-23" });
    store.close();
  });

  test("delivery MCP preserves legacy PR data beside neutral data for absent, open, merged and check-log states", async () => {
    const { service, context, store, setDeliveryMerged } = await setup();
    const factory = (service as unknown as { mcpFactory(): { create(input: any): Promise<any> } }).mcpFactory();
    const call = async (tool: string, input = {}) => {
      const lease = await factory.create({ runId: `run-${tool}`, stageId: "implementation", context, allowedTools: [tool], actor: { id: "worker", name: "Worker", title: "Engineer" } });
      const file = path.join(context.repository.folder, "..", "artifacts", `run-${tool}`, "mcp-context.json");
      const token = JSON.parse(await readFile(file, "utf8")).control.token as string;
      try { return await service.handleMcp({ tool, input }, token); } finally { await lease.close(); }
    };
    expect(await call("delivery.get_state")).toEqual({ change: null, pullRequest: null, checks: [] });
    store.upsertPullRequest({ issueId: "issue", id: "github:owner/repo#pr-23", number: 23, url: "https://github.com/owner/repo/pull/23", state: "open" });
    expect(await call("delivery.get_state")).toMatchObject({
      change: { id: "github:owner/repo#pr-23", number: 23, state: "open", headSha: "head-sha-23", draft: false, mergeable: true },
      pullRequest: { number: 23, state: "open", headSha: "head-sha-23" },
      checks: [{ name: "Tests", state: "passed" }],
    });
    store.upsertPullRequest({ issueId: "issue", id: "github:owner/repo#pr-23", number: 23, url: "https://github.com/owner/repo/pull/23", state: "merged", mergedAt: "2026-01-02T00:00:00.000Z" });
    setDeliveryMerged(true);
    expect(await call("delivery.get_state")).toMatchObject({ change: { state: "merged", mergedAt: "2026-01-02T00:00:00.000Z" }, pullRequest: { state: "merged", merged: true } });
    expect(await call("delivery.get_check_logs", { checkName: "Tests" })).toMatchObject({
      change: { headSha: "head-sha-23" }, pullRequest: { headSha: "head-sha-23" },
      checks: [{ name: "Tests", log: "test failed" }],
    });
    expect(requestLog).toContainEqual({ op: "checks", sha: "head-sha-23" });
    expect(requestLog).toContainEqual({ op: "log", id: 7 });
    store.close();
  });

  test("opens pre-upgrade pull_requests rows with the original GitHub identity and merged state", async () => {
    const { service, context, store, setDeliveryMerged } = await setup({ legacyDatabase: true });
    setDeliveryMerged(true);
    expect(store.getCurrentPullRequest("issue")).toMatchObject({
      id: "github:owner/repo#pr-23", number: 23, url: "https://github.com/owner/repo/pull/23", state: "merged", mergedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(store.hasMergedPullRequest("issue")).toBe(true);
    const factory = (service as unknown as { mcpFactory(): { create(input: any): Promise<any> } }).mcpFactory();
    const lease = await factory.create({ runId: "legacy-delivery", stageId: "implementation", context, allowedTools: ["delivery.get_state"], actor: { id: "worker", name: "Worker", title: "Engineer" } });
    const file = path.join(context.repository.folder, "..", "artifacts", "legacy-delivery", "mcp-context.json");
    const token = JSON.parse(await readFile(file, "utf8")).control.token as string;
    try {
      expect(await service.handleMcp({ tool: "delivery.get_state", input: {} }, token)).toMatchObject({
        change: { id: "github:owner/repo#pr-23", state: "merged" },
        pullRequest: { number: 23, state: "merged", merged: true },
      });
    } finally { await lease.close(); store.close(); }
  });
});
