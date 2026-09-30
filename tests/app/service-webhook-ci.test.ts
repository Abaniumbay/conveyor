import { createHmac } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { ConveyorService } from "../../src/app/service";
import { CodeHostRegistry } from "../../src/codehost/registry";
import type { CodeHost } from "../../src/codehost/types";
import type { RuntimeIssueContext } from "../../src/app/runtime";
import type { CiProvider } from "../../src/app/ci-provider";
import type { GitHubAdapter } from "../../src/source/github/adapter";

const roots: string[] = [];
const priorSecret = process.env.CONVEYOR_GITHUB_WEBHOOK_SECRET;

afterEach(async () => {
  if (priorSecret === undefined) delete process.env.CONVEYOR_GITHUB_WEBHOOK_SECRET;
  else process.env.CONVEYOR_GITHUB_WEBHOOK_SECRET = priorSecret;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function command(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-webhook-ci-"));
  roots.push(root);
  const repoFolder = path.join(root, "repository");
  const remote = path.join(root, "remote.git");
  await mkdir(repoFolder);
  await mkdir(path.join(root, "workspace"));
  await writeFile(path.join(root, "agent.md"), "Work.");
  await command(root, "init", "--bare", remote);
  await command(path.join(root, "workspace"), "init", "-b", "feature");
  await command(path.join(root, "workspace"), "config", "user.email", "test@example.com");
  await command(path.join(root, "workspace"), "config", "user.name", "Test");
  await writeFile(path.join(root, "workspace", "README.md"), "test\n");
  await command(path.join(root, "workspace"), "add", "README.md");
  await command(path.join(root, "workspace"), "commit", "-m", "test");
  await command(path.join(root, "workspace"), "remote", "add", "origin", remote);
  await command(path.join(root, "workspace"), "push", "-u", "origin", "feature");
  const configPath = path.join(root, "config.yml");
  await writeFile(configPath, `
settings:
  database: ${root}/db.sqlite
  logs: ${root}/logs
  workspaces: ${root}/workspaces
  artifacts: ${root}/artifacts
sources:
  github: { type: github, webhookPath: /custom/hook }
runners:
  codex: { type: codex, command: codex }
agents:
  worker: { runner: codex, instructions: ./agent.md }
checks: {}
ci: {}
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
      - id: ci
        run: { agent: worker }
        concurrency: 1
repositories:
  repo:
    source: github
    address: owner/repo
    folder: ${repoFolder}
    pipeline: default
`);
  const config = await loadConfig(configPath);
  const store = await ConveyorStore.open(config.settings.database);
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: repoFolder, configHash: config.hash });
  store.upsertIssue({
    id: "issue", repositoryId: "repo", sourceNumber: 1, sourceUrl: "https://github.com/owner/repo/issues/1",
    title: "Feature", body: "", sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  store.activateEnrollment("issue");
  store.upsertPullRequest({ issueId: "issue", id: "pr-9", number: 9, url: "https://github.com/owner/repo/pull/9", state: "open" });

  const github = {
    async ensurePullRequest() { return { number: 9, url: "https://github.com/owner/repo/pull/9", state: "open" }; },
  } as unknown as GitHubAdapter;
  const headSha = (await Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: path.join(root, "workspace") })).stdout.toString().trim();
  const codeHosts = new CodeHostRegistry().register("github", {
    async pushBranch() { return { pushed: true }; },
    async ensureChange() {
      return { id: "pr-9", number: 9, url: "https://github.com/owner/repo/pull/9", state: "open", headSha, draft: false, mergeable: null };
    },
    async getChange() {
      return { id: "pr-9", number: 9, url: "https://github.com/owner/repo/pull/9", state: "open", headSha, draft: false, mergeable: null };
    },
    async mergeChange() { return { merged: true }; },
    async getChangeDelivery() {
      return {
        change: { id: "pr-9", number: 9, url: "https://github.com/owner/repo/pull/9", state: "open", headSha, draft: false, mergeable: null },
        checks: [],
      };
    },
  } satisfies CodeHost);
  const service = new ConveyorService(config, store, github, { codeHosts });
  const issue = store.getIssue("issue")!;
  const workspace = { path: path.join(root, "workspace"), branch: "feature" };
  const context: RuntimeIssueContext = {
    issue,
    repository: { id: "repo", address: "owner/repo", folder: repoFolder, baseBranch: "main" },
    workspace: null,
    sourceGuidance: "",
  };
  process.env.CONVEYOR_GITHUB_WEBHOOK_SECRET = "test-secret";
  return { root, config, store, service, context, workspace, headSha, github, codeHosts, async close() { store.close(); } };
}

function provider(runs: () => Array<{ id: string; name: string; url: null; state: "queued" | "passed"; canRerun: false; hasLog: false }>, sha: string): CiProvider {
  return {
    async currentCommit() { return sha; },
    async start() { return []; },
    async list() { return runs(); },
    async rerun() {},
    async log() { return ""; },
  };
}

function signedWorkflow(deliveryId: string, repository: string, sha: string) {
  const body = new TextEncoder().encode(JSON.stringify({
    action: "completed",
    repository: { full_name: repository },
    workflow_run: { status: "completed", head_sha: sha },
  }));
  const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
  return { body, headers: new Headers({
    "x-hub-signature-256": signature,
    "x-github-delivery": deliveryId,
    "x-github-event": "workflow_run",
  }) };
}

describe("service CI webhook and polling recovery", () => {
  test("signed completion wakes a genuinely parked gate and ignores unrelated commits and repositories", async () => {
    const fixture = await setup();
    let queue: Array<{ id: string; name: string; url: null; state: "queued" | "passed"; canRerun: false; hasLog: false }> = [
      { id: "1", name: "checks", url: null, state: "queued", canRerun: false, hasLog: false },
    ];
    const calls: string[] = [];
    const service = fixture.service as unknown as Record<string, (...args: never[]) => unknown>;
    service.ciProvider = () => provider(() => queue, fixture.headSha);
    service.updateStatusComment = async () => {};
    const options = { settleSeconds: 0.001, pollSeconds: 0.001 };
    const gate = (service.awaitPullRequestChecks as (context: RuntimeIssueContext, workspace: { path: string; branch: string }, input: Record<string, unknown>) => Promise<unknown>).bind(fixture.service);
    const defer = (service.deferForExternalWait as (issue: NonNullable<ReturnType<typeof fixture.store.getIssue>>, error: Error & { retryAfterMs: number; commitSha: string }) => Promise<void>).bind(fixture.service);
    let reevaluation: unknown;
    service.schedule = () => {
      calls.push("scheduled");
      if (reevaluation !== undefined) return;
      void gate(fixture.context, fixture.workspace, options).then(
        (result) => { reevaluation = result; },
        (error) => { reevaluation = error; },
      );
    };
    let wait: (Error & { retryAfterMs: number; commitSha: string }) | undefined;
    try { await gate(fixture.context, fixture.workspace, options); } catch (error) { wait = error as typeof wait; }
    if (!wait?.commitSha) throw wait;
    expect(wait?.commitSha).toBe(fixture.headSha);
    await defer(fixture.store.getIssue("issue")!, wait!);
    calls.length = 0;

    const unrelated = signedWorkflow("unrelated-commit", "owner/repo", "f".repeat(40));
    await fixture.service.handleWebhook(unrelated.body, unrelated.headers);
    const otherRepo = signedWorkflow("other-repo", "someone/else", fixture.headSha);
    await fixture.service.handleWebhook(otherRepo.body, otherRepo.headers);
    expect(calls).toEqual([]);

    const completed = signedWorkflow("matching-completion", "owner/repo", fixture.headSha);
    queue = [{ id: "1", name: "checks", url: null, state: "passed", canRerun: false, hasLog: false }];
    await Bun.sleep(5);
    await fixture.service.handleWebhook(completed.body, completed.headers);
    expect(calls).toEqual(["scheduled"]);
    await Bun.sleep(300);
    expect(reevaluation).toMatchObject({ outcome: "success" });
    await fixture.close();
  });

  test("pending gates remain eligible through polling and after service restart", async () => {
    const fixture = await setup();
    const waiting = [{ id: "1", name: "checks", url: null, state: "queued" as const, canRerun: false as const, hasLog: false as const }];
    const passing = [{ id: "1", name: "checks", url: null, state: "passed" as const, canRerun: false as const, hasLog: false as const }];
    const service = fixture.service as unknown as Record<string, (...args: never[]) => unknown>;
    service.ciProvider = () => provider(() => waiting, fixture.headSha);
    service.updateStatusComment = async () => {};
    let scheduled = 0;
    service.schedule = () => { scheduled += 1; };
    const gate = (service.awaitPullRequestChecks as (context: RuntimeIssueContext, workspace: { path: string; branch: string }, input: Record<string, unknown>) => Promise<unknown>).bind(fixture.service);
    const defer = (service.deferForExternalWait as (issue: NonNullable<ReturnType<typeof fixture.store.getIssue>>, error: Error & { retryAfterMs: number; commitSha: string }) => Promise<void>).bind(fixture.service);
    const options = { settleSeconds: 0.001, pollSeconds: 0.01 };
    let wait: (Error & { retryAfterMs: number; commitSha: string }) | undefined;
    try { await gate(fixture.context, fixture.workspace, options); } catch (error) { wait = error as typeof wait; }
    if (!wait?.commitSha) throw wait;
    await defer(fixture.store.getIssue("issue")!, wait!);
    await Bun.sleep(80);
    expect(scheduled).toBeGreaterThan(0);

    await fixture.close();
    const restartedStore = await ConveyorStore.open(fixture.config.settings.database);
    const restarted = new ConveyorService(fixture.config, restartedStore, fixture.github, { codeHosts: fixture.codeHosts });
    const restartedMethods = restarted as unknown as Record<string, (...args: never[]) => unknown>;
    restartedMethods.ciProvider = () => provider(() => passing, fixture.headSha);
    const restartedGate = (restartedMethods.awaitPullRequestChecks as (context: RuntimeIssueContext, workspace: { path: string; branch: string }, input: Record<string, unknown>) => Promise<{ outcome: string }>).bind(restarted);
    let restartedWait: unknown;
    try { await restartedGate(fixture.context, fixture.workspace, options); } catch (error) { restartedWait = error; }
    expect(restartedWait).toBeInstanceOf(Error);
    await Bun.sleep(5);
    await expect(restartedGate(fixture.context, fixture.workspace, options)).resolves.toMatchObject({ outcome: "success" });
    restartedStore.close();
  });
});
