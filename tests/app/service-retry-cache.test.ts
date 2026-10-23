import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import type { ConveyorConfig } from "../../src/config/load";
import { configSchema } from "../../src/config/schema";
import { ConveyorStore } from "../../src/db/store";
import type { Harness, HarnessRunInput } from "../../src/harness/types";
import { EMPTY_USAGE, UNAVAILABLE_COST, type RunEnvelope } from "../../src/runner/result";
import { GitHubAdapter, type GitHubIssue, type GitHubTransport, type GitHubTransportRequest } from "../../src/source/github/adapter";
import { GitHubReadCache } from "../../src/source/github/read-cache";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function config(root: string, ciRetryRoute = false, implementationAgent = false): ConveyorConfig {
  const parsed = configSchema.parse({
    settings: {
      database: path.join(root, "conveyor.sqlite"),
      logs: path.join(root, "logs"),
      artifacts: path.join(root, "artifacts"),
      workspaces: path.join(root, "workspaces"),
      runners: 1,
    },
    sources: { github: { type: "github" } },
    runners: implementationAgent ? { codex: { type: "codex" } } : {},
    labels: {
      enrollment: "conveyor",
      stageTemplate: "conveyor:{stage}",
      states: { blocked: "conveyor:blocked", done: "conveyor:done", "needs-intervention": "conveyor:needs-intervention" },
      metadata: { closable: "conveyor:closable", noSplit: "conveyor:no-split", orderTemplate: "conveyor:order:{number}" },
    },
    pipelines: {
      default: {
        successStatuses: ["done"],
        failureStatuses: ["blocked"],
        stages: ciRetryRoute
          ? [
              {
                id: "implementation",
                concurrency: 1,
                actions: implementationAgent ? [{ task: "agent.run", with: { agent: "worker" } }] : [],
                "exit-gate": [{ id: "acknowledge", task: "item.followUps", manual: true }],
              },
              { id: "ci-gate", concurrency: 1, actions: [], "exit-gate": [{ id: "required-ci", task: "ci.passed", onFail: { return: "implementation" } }] },
            ]
          : [{ id: "implementation", concurrency: 1, actions: [], "exit-gate": [{ id: "acknowledge", task: "item.followUps", manual: true }] }],
      },
    },
    repositories: {
      repo: { source: "github", address: "owner/my-app", folder: root, pipeline: "default" },
    },
    agents: implementationAgent
      ? { worker: { runner: "codex", instructions: path.join(root, "worker.md"), name: "Worker", title: "Builder" } }
      : {},
  });
  return { ...parsed, hash: "retry-cache-test", root, plans: [] };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

function issue(labels: string[]): GitHubIssue {
  return {
    id: 3,
    number: 3,
    html_url: "https://example.com/issues/3",
    title: "Retry without stale cache",
    body: "The source body.",
    state: "open",
    labels: labels.map((name) => ({ name })),
    updated_at: "2026-10-22T18:00:00Z",
  };
}

/** An offline GitHub transport whose first held listing predates the retry label write. */
class RetryTransport implements GitHubTransport {
  #current: GitHubIssue;

  constructor(initialLabels: string[] = ["conveyor", "conveyor:implementation", "conveyor:blocked", "area:backend"], private readonly retryLabels = ["conveyor", "conveyor:implementation", "area:backend"]) {
    this.#current = issue(initialLabels);
  }

  async request<T>(request: GitHubTransportRequest): Promise<T> {
    if (request.method === "GET" && request.path === "repos/owner/my-app/issues?state=all&per_page=100&sort=created&direction=asc") {
      return [structuredClone(this.#current)] as T;
    }
    if (request.method === "GET" && request.path === "repos/owner/my-app/issues/3") return structuredClone(this.#current) as T;
    if (request.method === "PUT" && request.path === "repos/owner/my-app/issues/3/labels") {
      this.#current = issue(this.retryLabels);
      return structuredClone(this.#current.labels) as T;
    }
    if (request.method === "GET" && request.path === "repos/owner/my-app/issues/3/sub_issues?per_page=100") return [] as T;
    if (request.method === "GET" && request.path === "repos/owner/my-app/issues/3/dependencies/blocked_by?per_page=100") return [] as T;
    if (request.method === "GET" && request.path === "repos/owner/my-app/issues/3/comments?per_page=100") return [] as T;
    if (request.method === "POST" && request.path === "repos/owner/my-app/issues/3/comments") {
      return { id: 1, html_url: "https://example.com/issues/3#comment-1" } as T;
    }
    if (request.method === "PATCH" && request.path === "repos/owner/my-app/issues/comments/1") {
      return { id: 1, html_url: "https://example.com/issues/3#comment-1" } as T;
    }
    if (request.method === "GET" && request.path === "repos/owner/my-app") return { private: false } as T;
    throw new Error(`Unexpected offline GitHub request: ${request.method} ${request.path}`);
  }
}

describe("ConveyorService retry with a held GitHub listing", () => {
  test("keeps the retry active at its stage without another resume journey when the subsequent poll is cached", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-retry-cache-"));
    directories.push(root);
    const current = config(root);
    const store = await ConveyorStore.open(current.settings.database);
    const adapter = new GitHubAdapter(new GitHubReadCache(new RetryTransport()), current.settings.labelPrefix);
    const service = new ConveyorService(current, store, adapter);
    const issueId = "github:owner/my-app#3";
    try {
      store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: root, configHash: current.hash });
      store.upsertIssue({
        id: issueId,
        repositoryId: "repo",
        sourceNumber: 3,
        sourceUrl: "https://example.com/issues/3",
        title: "Retry without stale cache",
        body: "The source body.",
        sourceState: "open",
        sourceStateReason: null,
        labels: ["conveyor", "conveyor:implementation", "conveyor:blocked", "area:backend"],
        sourceUpdatedAt: "2026-10-22T18:00:00Z",
        acceptedTextAt: "2026-10-22T18:00:00Z",
      });
      store.setQueueRank(issueId, 10);
      store.setIssueProjection(issueId, { stage: "implementation", state: "blocked", warning: null });
      store.setStageState({ issueId, stageId: "implementation", status: "blocked", feedbackCycle: 0, configHash: current.hash });

      await adapter.listIssues("owner/my-app");
      service.drain("Keep the integration test's retry from starting an agent run.");
      await service.retryIssue(issueId, "", "operator");
      const journeysAfterRetry = store.listStageTransitions(issueId).filter((entry) => entry.kind === "resumed");

      await service.reconcileAll();

      expect(store.getIssue(issueId)).toMatchObject({ projectedState: "active", projectedStage: "implementation" });
      expect(store.listStageTransitions(issueId).filter((entry) => entry.kind === "resumed")).toEqual(journeysAfterRetry);
    } finally {
      await service.close();
    }
  });

  test("keeps a repeated CI gate failure's feedback when retrying after a service restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-ci-retry-"));
    directories.push(root);
    await git(root, "init", "-b", "main");
    await git(root, "config", "user.email", "tests@example.test");
    await git(root, "config", "user.name", "Tests");
    await writeFile(path.join(root, "README.md"), "fixture\n");
    await writeFile(path.join(root, "worker.md"), "Act on the item feedback.");
    await git(root, "add", "README.md", "worker.md");
    await git(root, "commit", "-m", "fixture");
    const current = config(root, true, true);
    const store = await ConveyorStore.open(current.settings.database);
    const issueId = "github:owner/my-app#3";
    const feedback = {
      from: { stage: "ci-gate", taskInstanceId: "required-ci" },
      message: "The same required CI failure repeated.",
      details: { evidence: ["required-ci-run"] },
    };
    store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: root, configHash: current.hash });
    store.upsertIssue({
      id: issueId, repositoryId: "repo", sourceNumber: 3, sourceUrl: "https://example.com/issues/3", title: "Retry without stale cache",
      body: "The source body.", sourceState: "open", sourceStateReason: null,
      labels: ["conveyor", "conveyor:ci-gate", "conveyor:needs-intervention", "area:backend"],
      sourceUpdatedAt: "2026-10-22T18:00:00Z", acceptedTextAt: "2026-10-22T18:00:00Z",
    });
    store.setQueueRank(issueId, 10);
    store.setIssueProjection(issueId, { stage: "ci-gate", state: "needs-intervention", warning: feedback.message });
    store.setStageState({ issueId, stageId: "ci-gate", status: "needs-intervention", feedbackCycle: 0, configHash: current.hash });
    store.activateEnrollment(issueId);
    store.beginStageTransition({
      id: "ci-repeat", issueId, fromStage: "ci-gate", toStage: "ci-gate", kind: "stopped", sourceMutationId: null,
      detail: { reason: feedback.message, requiredFixes: ["Repair the required check."], resultStatus: "needs-intervention", retryTargetStage: "implementation", retryFeedback: feedback },
    });
    store.completeStageTransition("ci-repeat");

    const transport = new RetryTransport(
      ["conveyor", "conveyor:ci-gate", "conveyor:needs-intervention", "area:backend"],
      ["conveyor", "conveyor:implementation", "area:backend"],
    );
    const adapter = new GitHubAdapter(new GitHubReadCache(transport), current.settings.labelPrefix);
    const calls: HarnessRunInput[] = [];
    const harness: Harness = {
      id: "fake",
      get capabilities() { return { sessionResume: true }; },
      async run(input): Promise<RunEnvelope> {
        calls.push(input);
        return {
          stageResult: { outcome: "success", status: "done", summary: "Done", reason: null, metrics: {} },
          sessionId: "session", usage: { ...EMPTY_USAGE }, cost: { ...UNAVAILABLE_COST }, durationMs: 1, exitCode: 0, artifacts: [], stderr: "",
        };
      },
    };
    const stoppedService = new ConveyorService(current, store, adapter, { harnesses: { codex: harness } });
    await stoppedService.close();
    const restartedStore = await ConveyorStore.open(current.settings.database);
    const restartedService = new ConveyorService(current, restartedStore, adapter, { harnesses: { codex: harness } });
    try {
      await restartedService.retryIssue(issueId, "", "operator");

      expect(restartedStore.getIssue(issueId)).toMatchObject({ projectedStage: "implementation", projectedState: "active" });
      const deadline = Date.now() + 1_000;
      while (calls.length === 0 && Date.now() < deadline) await Bun.sleep(10);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.prompt).toContain(feedback.message);
      expect(calls[0]!.prompt).toContain("required-ci-run");
    } finally {
      await restartedService.close();
    }
  });
});
