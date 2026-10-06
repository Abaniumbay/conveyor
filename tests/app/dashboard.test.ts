import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import { createWebAuth, hashPassword } from "../../src/web/auth";
import { createWebHandler } from "../../src/web/server";
import type { RuntimeIssueContext, ScopedMcpFactory } from "../../src/app/runtime";
import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import { ItemTodos } from "../../src/engine/todos";
import { parseManagedSections } from "../../src/source/github/managed-sections";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("ConveyorService dashboard", () => {
  test("serves health and login promptly during cold and expired dashboard quota scans", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-dashboard-quota-http-"));
    temporaryDirectories.push(root);
    const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
    const config = {
      hash: "config-hash",
      root,
      settings: { workspaces: path.join(root, "workspaces"), runners: 1 },
      runners: { codex: { type: "codex" } },
      sources: { github: { type: "github" } },
      repositories: {}, agents: {}, pipelines: {},
      labels: { enrollment: "conveyor", stageTemplate: "conveyor:{stage}", states: {}, metadata: { closable: "conveyor:closable" } },
    } as unknown as ConveyorConfig;
    const service = new ConveyorService(config, store, {} as never);
    const auth = createWebAuth({
      username: "operator",
      passwordHash: hashPassword("correct horse", { salt: "0123456789abcdef" }),
      sessionSecret: "session-secret-that-is-at-least-thirty-two-bytes",
      secureCookies: false,
    });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createWebHandler(service.webDependencies(auth, "operator")) });
    const sessions = path.join(root, "codex", "sessions");
    await mkdir(sessions, { recursive: true });
    for (let index = 0; index < 1_000; index += 1) {
      await writeFile(path.join(sessions, `session-${String(index).padStart(4, "0")}.jsonl`), `${"{}\n".repeat(256)}`);
    }
    const quotaFile = path.join(sessions, "newest.jsonl");
    const reportedAt = new Date();
    await writeFile(quotaFile, JSON.stringify({ timestamp: reportedAt.toISOString(), payload: { type: "token_count", rate_limits: {
      primary: { used_percent: 1, window_minutes: 10080, resets_at: Math.floor(reportedAt.getTime() / 1000) + 7 * 24 * 60 * 60 },
      secondary: { used_percent: 20, window_minutes: 300, resets_at: Math.floor(reportedAt.getTime() / 1000) + 5 * 60 * 60 },
    } } }) + "\n");
    await utimes(quotaFile, reportedAt, reportedAt);
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(root, "codex");
    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const loggedIn = await fetch(`${baseUrl}/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: "operator", password: "correct horse" }),
      });
      const cookie = loggedIn.headers.get("set-cookie")!.split(";")[0]!;
      let now = Date.now();
      const dateNow = spyOn(Date, "now").mockImplementation(() => now);
      try {
        const checkHttpResponsiveness = async () => {
          const dashboard = fetch(`${baseUrl}/board`, { headers: { cookie } });
          const healthStarted = performance.now();
          const health = fetch(`${baseUrl}/health/live`);
          const loginStarted = performance.now();
          const login = fetch(`${baseUrl}/login`);
          const [dashboardResponse, healthResponse, loginResponse] = await Promise.all([dashboard, health, login]);
          expect(dashboardResponse.status).toBe(200);
          expect(await dashboardResponse.text()).toContain("99% left");
          expect(healthResponse.status).toBe(200);
          expect(loginResponse.status).toBe(200);
          expect(performance.now() - healthStarted).toBeLessThan(250);
          expect(performance.now() - loginStarted).toBeLessThan(250);
        };
        await checkHttpResponsiveness();
        now += 30_001;
        await checkHttpResponsiveness();
      } finally {
        dateNow.mockRestore();
      }
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      server.stop(true);
      store.close();
    }
  });

  test("retries stopped issues at their current stage, retaining labels and recording only supplied feedback after source success", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-retry-"));
    temporaryDirectories.push(root);
    const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
    const config = {
      hash: "config-hash", root,
      settings: { artifacts: path.join(root, "artifacts"), workspaces: path.join(root, "workspaces"), runners: 1, labelPrefix: "conveyor" },
      web: { listen: "127.0.0.1:4300" }, sources: { github: { type: "github" } },
      labels: {
        enrollment: "conveyor", stageTemplate: "conveyor:{stage}",
        states: { done: "conveyor:done", blocked: "conveyor:blocked", error: "conveyor:error", "needs-intervention": "conveyor:needs-intervention" },
        metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" },
      },
      pipelines: { default: { successStatuses: ["done"], failureStatuses: ["blocked"], stages: [{ id: "implementation", run: { type: "agent", agent: "implementer" }, concurrency: 1, failurePolicies: {}, afterSuccess: [] }, { id: "review", run: { type: "agent", agent: "reviewer" }, concurrency: 1, failurePolicies: {}, afterSuccess: [] }, { id: "deploy", run: { type: "agent", agent: "deployer" }, concurrency: 1, failurePolicies: {}, afterSuccess: [] }] } },
      repositories: { repo: { source: "github", address: "owner/repo", folder: root, baseBranch: "main", pipeline: "default", concurrency: 1, systemLabels: [] } },
      agents: {},
    } as unknown as ConveyorConfig;
    store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: root, configHash: config.hash });
    const issues = ["with-note", "without-note", "failed", "stale", "error", "intervention", "closed-merged"].map((id, index) => ({
      id, number: index + 1, url: `https://github.com/owner/repo/issues/${index + 1}`, title: id,
      body: "keep this body", state: id === "closed-merged" ? "closed" as const : "open" as const, stateReason: null,
      labels: ["conveyor", id === "closed-merged" ? "conveyor:deploy" : "conveyor:implementation", `conveyor:${id === "error" ? "error" : id === "intervention" ? "needs-intervention" : "blocked"}`, "conveyor:order:7", "area:web", "priority:high"],
      updatedAt: "2026-10-01T00:00:00Z",
    }));
    const blocker = { id: "blocker", number: 8, url: "https://github.com/owner/repo/issues/8", title: "Blocker", body: "", state: "open" as const, stateReason: null, labels: [], updatedAt: "2026-10-01T00:00:00Z" };
    for (const issue of issues) {
      store.upsertIssue({ id: issue.id, repositoryId: "repo", sourceNumber: issue.number, sourceUrl: issue.url, title: issue.title, body: issue.body, sourceState: issue.state, sourceStateReason: null, labels: issue.labels, sourceUpdatedAt: issue.updatedAt });
      store.setQueueRank(issue.id, issue.number);
      const stoppedState = issue.id === "error" ? "error" : issue.id === "intervention" ? "needs-intervention" : "blocked";
      const stageId = issue.id === "closed-merged" ? "deploy" : "implementation";
      store.setIssueProjection(issue.id, { stage: stageId, state: stoppedState, warning: null });
      store.setStageState({ issueId: issue.id, stageId, status: stoppedState, feedbackCycle: 2, configHash: config.hash });
    }
    store.upsertIssue({ id: blocker.id, repositoryId: "repo", sourceNumber: blocker.number, sourceUrl: blocker.url, title: blocker.title, body: blocker.body, sourceState: blocker.state, sourceStateReason: null, labels: blocker.labels, sourceUpdatedAt: blocker.updatedAt });
    store.setIssueProjection(blocker.id, { stage: null, state: "offboarded", warning: null });
    for (const issue of issues) store.replaceRelationships(issue.id, null, ["blocker"]);
    store.activateEnrollment("closed-merged");
    store.upsertPullRequest({ issueId: "closed-merged", id: "merged-pr", number: 100, url: "https://github.com/owner/repo/pull/100", state: "merged", mergedAt: "2026-10-01T00:00:00Z" });
    const enrollment = store.activateEnrollment("with-note");
    store.recordWorkspace({ id: "existing-worktree", enrollmentId: enrollment.id, path: path.join(root, "existing-worktree"), branch: "conveyor/1-r1-feature", status: "active" });
    store.createRun({ id: "prior-run", issueId: "with-note", stageId: "implementation", attempt: 1, kind: "producer", status: "completed", configHash: config.hash, startedAt: "2026-09-30T00:00:00Z" });
    const replacements: string[][] = [];
    const github = {
      async getIssue(_address: string, number: number) {
        const issue = issues.find((candidate) => candidate.number === number)!;
        return number === 4 ? { ...issue, state: "closed" as const } : issue;
      },
      async replaceConveyorLabels(_address: string, number: number, labels: readonly string[]) {
        if (number === 3) throw new Error("source label update failed");
        replacements.push([...labels]);
        const issue = issues.find((candidate) => candidate.number === number)!;
        issue.labels = [...labels, ...issue.labels.filter((label) => !label.startsWith("conveyor:") && label !== "conveyor")];
      },
      async listIssues() { return [...issues, blocker]; }, async listSubIssues() { return []; }, async listDependencies(_address: string, number: number) { return number <= 7 ? [blocker] : []; },
      async upsertStatusComment() { return 1; },
    };
    const service = new ConveyorService(config, store, github as never);
    const before = service.dashboard("csrf");
    const closedCard = [...before.stages.flatMap((stage) => stage.issues), ...before.attention.issues].find((issue) => issue.id === "closed-merged");
    expect(closedCard?.retryable).toBe(true);
    await expect(service.retryIssue("with-note", "Android run passed", "operator")).resolves.toMatchObject({ status: "queued", stageId: "implementation" });
    await expect(service.retryIssue("without-note", "", "operator")).resolves.toMatchObject({ status: "queued", stageId: "implementation" });
    await expect(service.retryIssue("failed", "do not record this", "operator")).rejects.toThrow("source label update failed");
    await expect(service.retryIssue("stale", "do not record this either", "operator")).rejects.toThrow("inconsistent; refresh before retrying");
    await expect(service.retryIssue("error", "runner recovered", "operator")).resolves.toMatchObject({ status: "queued", stageId: "implementation" });
    await expect(service.retryIssue("intervention", "approval is ready", "operator")).resolves.toMatchObject({ status: "queued", stageId: "implementation" });
    await expect(service.retryIssue("closed-merged", "checkout cleaned", "operator")).resolves.toMatchObject({ status: "queued", stageId: "deploy" });
    expect(store.getIssue("closed-merged")).toMatchObject({ sourceState: "closed", projectedState: "active", projectedStage: "deploy" });
    expect(store.getCurrentPullRequest("closed-merged")?.id).toBe("merged-pr");
    expect(store.listConversationMessages("closed-merged").filter((message) => message.actorType === "user").map((message) => message.message)).toEqual(["checkout cleaned"]);
    expect(replacements).toEqual([
      ["conveyor", "conveyor:implementation", "conveyor:order:7"],
      ["conveyor", "conveyor:implementation", "conveyor:order:7"],
      ["conveyor", "conveyor:implementation", "conveyor:order:7"],
      ["conveyor", "conveyor:implementation", "conveyor:order:7"],
      ["conveyor", "conveyor:deploy", "conveyor:order:7"],
    ]);
    expect(issues[0]!.labels).toContain("priority:high");
    expect(issues[0]!.labels).toContain("area:web");
    expect(store.getIssue("with-note")).toMatchObject({ projectedState: "active", projectedStage: "implementation", body: "keep this body" });
    expect(store.listConversationMessages("with-note").filter((message) => message.actorType === "user").map((message) => message.message)).toEqual(["Android run passed"]);
    expect(store.listConversationMessages("without-note").filter((message) => message.actorType === "user")).toEqual([]);
    expect(store.getStageState("with-note")).toMatchObject({ stageId: "implementation", status: "ready", feedbackCycle: 0 });
    expect(store.getActiveWorkspace("with-note")).toMatchObject({ id: "existing-worktree", path: path.join(root, "existing-worktree"), branch: "conveyor/1-r1-feature" });
    expect(store.listIssueRuns("with-note").map((run) => run.id)).toContain("prior-run");
    expect(store.getIssue("failed")).toMatchObject({ projectedState: "blocked", labels: expect.arrayContaining(["conveyor:blocked"]) });
    expect(store.listConversationMessages("failed").filter((message) => message.actorType === "user")).toEqual([]);
    expect(store.listConversationMessages("stale").filter((message) => message.actorType === "user")).toEqual([]);
    expect(store.listConversationMessages("error").filter((message) => message.actorType === "user").map((message) => message.message)).toEqual(["runner recovered"]);
    expect(store.listConversationMessages("intervention").filter((message) => message.actorType === "user").map((message) => message.message)).toEqual(["approval is ready"]);
    store.close();
  });

  test("marks only eligible stopped dashboard issues retryable and rejects invalid or stale retries without side effects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-retry-boundaries-"));
    temporaryDirectories.push(root);
    const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
    const config = {
      hash: "config-hash", root,
      settings: { artifacts: path.join(root, "artifacts"), workspaces: path.join(root, "workspaces"), runners: 1, labelPrefix: "conveyor" },
      web: { listen: "127.0.0.1:4300" }, sources: { github: { type: "github" } },
      labels: {
        enrollment: "conveyor", stageTemplate: "conveyor:{stage}",
        states: { done: "conveyor:done", blocked: "conveyor:blocked", error: "conveyor:error", "needs-intervention": "conveyor:needs-intervention", "needs-input": "conveyor:needs-input", rejected: "conveyor:rejected" },
        metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" },
      },
      pipelines: { default: { successStatuses: ["done"], failureStatuses: ["blocked"], stages: ["implementation", "review"].map((id) => ({ id, run: { type: "agent", agent: "implementer" }, concurrency: 1, failurePolicies: {}, afterSuccess: [] })) } },
      repositories: { repo: { source: "github", address: "owner/repo", folder: root, baseBranch: "main", pipeline: "default", concurrency: 1, systemLabels: [] } },
      agents: {},
    } as unknown as ConveyorConfig;
    store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: root, configHash: config.hash });

    const cases = [
      ["blocked", "blocked", true],
      ["error", "error", true],
      ["intervention", "needs-intervention", true],
      ["active", "active", true],
      ["needs-input", "needs-input", true],
      ["rejected", "rejected", true],
      ["closed", "blocked", true],
      ["unenrolled", "blocked", false],
      ["running", "blocked", true],
      ["rollup", "blocked", true],
      ["offboarded", "offboarded", true],
      ["stale-state", "blocked", true],
      ["stale-stage", "blocked", true],
    ] as const;
    const liveIssues = new Map<number, { id: string; number: number; url: string; title: string; body: string; state: "open" | "closed"; stateReason: null; labels: string[]; updatedAt: string }>();
    for (const [index, [id, projectedState, enrolled]] of cases.entries()) {
      const number = index + 1;
      const stop = ["blocked", "error", "needs-intervention"].includes(projectedState) ? projectedState : "blocked";
      const labels = [...(enrolled ? ["conveyor"] : []), "conveyor:implementation", `conveyor:${stop}`];
      const sourceIssue = {
        id, number, url: `https://github.com/owner/repo/issues/${number}`, title: id, body: "",
        state: id === "closed" ? "closed" as const : "open" as const, stateReason: null, labels, updatedAt: "2026-10-01T00:00:00Z",
      };
      store.upsertIssue({ id, repositoryId: "repo", sourceNumber: number, sourceUrl: sourceIssue.url, title: id, body: "", sourceState: sourceIssue.state, sourceStateReason: null, labels, sourceUpdatedAt: sourceIssue.updatedAt });
      store.setQueueRank(id, number);
      store.setIssueProjection(id, { stage: id === "offboarded" ? null : "implementation", state: projectedState, warning: null });
      store.setStageState({ issueId: id, stageId: "implementation", status: projectedState, feedbackCycle: 0, configHash: config.hash });
      const liveLabels = id === "active" || id === "stale-state"
        ? ["conveyor", "conveyor:implementation"]
        : id === "stale-stage"
          ? ["conveyor", "conveyor:review", "conveyor:blocked"]
          : labels;
      liveIssues.set(number, { ...sourceIssue, labels: liveLabels });
    }
    const child = {
      id: "rollup-child", number: 20, url: "https://github.com/owner/repo/issues/20", title: "child", body: "", state: "open" as const, stateReason: null,
      labels: ["conveyor", "conveyor:implementation"], updatedAt: "2026-10-01T00:00:00Z",
    };
    store.upsertIssue({ id: child.id, repositoryId: "repo", sourceNumber: child.number, sourceUrl: child.url, title: child.title, body: child.body, sourceState: child.state, sourceStateReason: null, labels: child.labels, sourceUpdatedAt: child.updatedAt });
    store.setIssueProjection(child.id, { stage: "implementation", state: "active", warning: null });
    store.replaceRelationships(child.id, { parentId: "rollup", siblingOrder: null }, []);
    store.createRun({ id: "active-run", issueId: "running", stageId: "implementation", attempt: 1, kind: "producer", status: "running", configHash: config.hash, startedAt: "2026-10-01T00:00:00Z" });

    store.activateEnrollment("closed");
    store.upsertPullRequest({ issueId: "closed", id: "unmerged-pr", number: 101, url: "https://github.com/owner/repo/pull/101", state: "open" });

    const replacements: string[][] = [];
    const github = {
      async getIssue(_address: string, number: number) {
        const issue = liveIssues.get(number);
        if (!issue) throw new Error("not found");
        return issue;
      },
      async replaceConveyorLabels(_address: string, _number: number, labels: readonly string[]) { replacements.push([...labels]); },
    };
    const service = new ConveyorService(config, store, github as never);
    const dashboard = service.dashboard("csrf");
    const cards = [...dashboard.stages.flatMap((stage) => stage.issues), ...dashboard.attention.issues, ...dashboard.backlog];
    const retryableById = Object.fromEntries(cards.map((issue) => [issue.id, issue.retryable]));
    expect(retryableById).toMatchObject({ blocked: true, error: true, intervention: true });
    expect(retryableById).toMatchObject({ active: false, "needs-input": false, rejected: false, closed: false, unenrolled: false, running: false, rollup: false });
    expect(retryableById).not.toHaveProperty("offboarded");

    const rejectedIds = ["active", "needs-input", "rejected", "closed", "unenrolled", "running", "rollup", "offboarded", "stale-state", "stale-stage"];
    for (const id of rejectedIds) {
      await expect(service.retryIssue(id, "must not be recorded", "operator")).rejects.toThrow();
      expect(store.listConversationMessages(id)).toEqual([]);
    }
    await expect(service.retryIssue("missing", "", "operator")).rejects.toThrow("issue not found");
    await expect(service.retryIssue("blocked", "x".repeat(4_001), "operator")).rejects.toThrow("4000 characters");
    expect(store.listConversationMessages("blocked")).toEqual([]);
    expect(replacements).toEqual([]);
    store.close();
  });

  test("a card carries the item's todo list with done/total progress and the current item", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-todos-"));
    temporaryDirectories.push(root);
    const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
    const config = {
      hash: "config-hash", root,
      settings: { artifacts: path.join(root, "artifacts"), workspaces: path.join(root, "workspaces"), runners: 1, labelPrefix: "conveyor" },
      web: { listen: "127.0.0.1:4300" }, sources: { github: { type: "github" } },
      labels: { enrollment: "conveyor", stageTemplate: "conveyor:{stage}", states: { done: "conveyor:done" }, metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" } },
      pipelines: { default: { successStatuses: ["done"], failureStatuses: ["blocked"], stages: [{ id: "implementation", run: { type: "agent", agent: "implementer" }, concurrency: 1, failurePolicies: {}, afterSuccess: [] }] } },
      repositories: { repo: { source: "github", address: "owner/repo", folder: root, baseBranch: "main", pipeline: "default", concurrency: 1, systemLabels: [] } },
      agents: {},
    } as unknown as ConveyorConfig;
    store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: root, configHash: config.hash });
    for (const [id, number] of [["with-todos", 1], ["without", 2]] as const) {
      store.upsertIssue({ id, repositoryId: "repo", sourceNumber: number, sourceUrl: `https://github.com/owner/repo/issues/${number}`, title: id, body: "", sourceState: "open", sourceStateReason: null, labels: ["conveyor", "conveyor:implementation"], sourceUpdatedAt: "2026-10-01T00:00:00Z" });
      store.setQueueRank(id, number);
      store.setIssueProjection(id, { stage: "implementation", state: "active", warning: null });
      store.setStageState({ issueId: id, stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: config.hash });
    }
    const items = [
      { id: "t1", text: "Repository", status: "done" as const },
      { id: "t2", text: "Endpoint", status: "pending" as const },
    ];
    new ItemTodos(store.sqlite()).set("with-todos", items, "run-1", "2026-10-03T10:00:00Z");

    const service = new ConveyorService(config, store, {} as never);
    const cards = service.dashboard("csrf").stages.flatMap((stage) => stage.issues);
    expect(cards.find((card) => card.id === "with-todos")!.todos).toEqual({ done: 1, total: 2, current: "Endpoint", items });
    expect(cards.find((card) => card.id === "without")!.todos).toBeNull();
    store.close();
  });

  test("a user conversation message clears a recoverable stop and queues the current stage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-resume-"));
    temporaryDirectories.push(root);
    const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
    const config = {
      hash: "config-hash",
      root,
      settings: { artifacts: path.join(root, "artifacts"), workspaces: path.join(root, "workspaces"), runners: 1 },
      web: { listen: "127.0.0.1:4300" },
      sources: { github: { type: "github" } },
      labels: {
        enrollment: "conveyor",
        stageTemplate: "conveyor:{stage}",
        states: {
          done: "conveyor:done",
          blocked: "conveyor:blocked",
          rejected: "conveyor:reject",
          "needs-input": "conveyor:needs-input",
        },
        metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" },
      },
      pipelines: {
        default: {
          successStatuses: ["done"],
          failureStatuses: ["blocked"],
          stages: [{
            id: "implementation",
            run: { type: "agent", agent: "implementer" },
            concurrency: 1,
            failurePolicies: {},
            afterSuccess: [],
          }],
        },
      },
      repositories: {
        repo: {
          source: "github",
          address: "owner/repo",
          folder: root,
          baseBranch: "main",
          pipeline: "default",
          concurrency: 1,
          systemLabels: [],
        },
      },
      agents: {},
    } as unknown as ConveyorConfig;
    store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: root, configHash: config.hash });
    const sourceIssues = [
      {
        id: "issue",
        number: 1,
        url: "https://github.com/owner/repo/issues/1",
        title: "Feature",
        body: "",
        state: "open",
        stateReason: null,
        labels: ["conveyor", "conveyor:implementation", "conveyor:blocked", "conveyor:order:3"],
        updatedAt: "2026-09-29T00:00:00Z",
      },
      {
        id: "blocker",
        number: 2,
        url: "https://github.com/owner/repo/issues/2",
        title: "Dependency",
        body: "",
        state: "open",
        stateReason: null,
        labels: [],
        updatedAt: "2026-09-29T00:00:00Z",
      },
    ];
    for (const sourceIssue of sourceIssues) {
      store.upsertIssue({
        id: sourceIssue.id,
        repositoryId: "repo",
        sourceNumber: sourceIssue.number,
        sourceUrl: sourceIssue.url,
        title: sourceIssue.title,
        body: sourceIssue.body,
        sourceState: sourceIssue.state,
        sourceStateReason: sourceIssue.stateReason,
        labels: sourceIssue.labels,
        sourceUpdatedAt: sourceIssue.updatedAt,
      });
    }
    store.setQueueRank("issue", 10);
    store.setIssueProjection("issue", { stage: "implementation", state: "blocked", warning: null });
    store.setStageState({ issueId: "issue", stageId: "implementation", status: "blocked", feedbackCycle: 2, configHash: config.hash });
    store.beginStageTransition({
      id: "blocked-transition",
      issueId: "issue",
      fromStage: "implementation",
      toStage: "implementation",
      kind: "stopped",
      sourceMutationId: null,
      detail: {
        reason: "The deployment API rejected the configured token with HTTP 401. A repository owner must replace the expired token before implementation can continue.",
        requiredFixes: ["Replace the expired deployment API token."],
        resultStatus: "blocked",
      },
    });
    store.completeStageTransition("blocked-transition");
    store.setIssueProjection("blocker", { stage: null, state: "offboarded", warning: null });
    store.replaceRelationships("issue", null, ["blocker"]);
    const replaced: string[][] = [];
    const github = {
      async replaceConveyorLabels(_address: string, _number: number, labels: readonly string[]) {
        replaced.push([...labels]);
        sourceIssues[0]!.labels = [...labels];
      },
      async listIssues() { return sourceIssues; },
      async listSubIssues() { return []; },
      async listDependencies(_address: string, number: number) {
        return number === 1 ? [sourceIssues[1]!] : [];
      },
      async upsertStatusComment() { return 1; },
    };
    const service = new ConveyorService(config, store, github as never);
    store.seedDashboardSuperuser("operator", "persisted-hash");

    expect(service.dashboard("csrf").stages[0]?.issues[0]).toMatchObject({
      state: "blocked",
      reason: "The deployment API rejected the configured token with HTTP 401. A repository owner must replace the expired token before implementation can continue.",
    });
    expect(service.issueJourney("issue")?.now).toMatchObject({
      state: "stopped",
      reason: "The deployment API rejected the configured token with HTTP 401. A repository owner must replace the expired token before implementation can continue.",
    });

    await expect(service.postIssueMessage("issue", "The API access blocker is resolved; please continue.", "operator")).resolves.toMatchObject({
      status: "queued",
      stageId: "implementation",
    });

    expect(replaced).toEqual([["conveyor", "conveyor:implementation", "conveyor:order:3"]]);
    expect(store.getIssue("issue")).toMatchObject({ projectedState: "active", projectedStage: "implementation" });
    expect(store.getStageState("issue")).toMatchObject({ stageId: "implementation", status: "ready", feedbackCycle: 0 });
    expect(store.listConversationMessages("issue").map((message) => ({ actor: message.actorName, message: message.message }))).toEqual([
      { actor: "operator", message: "The API access blocker is resolved; please continue." },
      { actor: "Conveyor", message: expect.stringContaining("Queued implementation") },
    ]);
    expect(service.issueConversation("issue")?.messages[0]).toMatchObject({ actorName: "operator", actorAvatar: "🐼" });
    expect(service.dashboard("csrf").activeWork.runnerCount).toBe(0);
    store.close();
  });

  test("a conversation message answers an open structured question before resuming", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-answer-"));
    temporaryDirectories.push(root);
    const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
    const config = {
      hash: "config-hash",
      root,
      settings: { artifacts: path.join(root, "artifacts"), workspaces: path.join(root, "workspaces"), runners: 1 },
      web: { listen: "127.0.0.1:4300" },
      sources: { github: { type: "github" } },
      labels: {
        enrollment: "conveyor",
        stageTemplate: "conveyor:{stage}",
        states: { done: "conveyor:done", "needs-input": "conveyor:needs-input" },
        metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" },
      },
      pipelines: {
        default: {
          successStatuses: ["done"],
          failureStatuses: ["needs-input"],
          stages: [{ id: "refinement", run: { type: "agent", agent: "refiner" }, concurrency: 1, failurePolicies: {}, afterSuccess: [] }],
        },
      },
      repositories: {
        repo: { source: "github", address: "owner/repo", folder: root, baseBranch: "main", pipeline: "default", concurrency: 1, systemLabels: [] },
      },
      agents: {},
    } as unknown as ConveyorConfig;
    store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: root, configHash: config.hash });
    const sourceIssue = {
      id: "issue",
      number: 1,
      url: "https://github.com/owner/repo/issues/1",
      title: "Feature",
      body: "",
      state: "open",
      stateReason: null,
      labels: ["conveyor", "conveyor:refinement", "conveyor:needs-input"],
      updatedAt: "2026-09-29T00:00:00Z",
    };
    store.upsertIssue({ id: "issue", repositoryId: "repo", sourceNumber: 1, sourceUrl: sourceIssue.url, title: sourceIssue.title, body: "", sourceState: "open", labels: sourceIssue.labels, sourceUpdatedAt: sourceIssue.updatedAt });
    store.setIssueProjection("issue", { stage: "refinement", state: "needs-input", warning: null });
    store.setStageState({ issueId: "issue", stageId: "refinement", status: "needs-input", feedbackCycle: 0, configHash: config.hash });
    const question = store.openQuestion({ issueId: "issue", runId: null, prompt: "Which layout?", reason: "A choice is required", options: [], allowFreeText: true });
    const comments: string[] = [];
    const github = {
      async addComment(_address: string, _number: number, markdown: string) { comments.push(markdown); return 1; },
      async replaceConveyorLabels(_address: string, _number: number, labels: readonly string[]) { sourceIssue.labels = [...labels]; },
      async listIssues() { return [sourceIssue]; },
      async listSubIssues() { return []; },
      async listDependencies() { return []; },
      async upsertStatusComment() { return 1; },
    };
    const service = new ConveyorService(config, store, github as never);

    await service.postIssueMessage("issue", "Use the compact layout.", "operator");

    expect(store.getQuestion(question.id)).toMatchObject({ status: "answered", answer: { answer: "Use the compact layout." } });
    expect(comments[0]).toContain("Use the compact layout.");
    expect(store.listConversationMessages("issue")[0]).toMatchObject({ actorType: "user", message: "Use the compact layout." });
    await service.close();
  });

  test("turns explicit MCP progress into shared conversation and exposes live handoff context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-conversation-"));
    temporaryDirectories.push(root);
    const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
    const config = {
      hash: "config-hash",
      root,
      settings: { artifacts: path.join(root, "artifacts"), workspaces: path.join(root, "workspaces") },
      web: { listen: "127.0.0.1:4300" },
      repositories: {},
      pipelines: {},
      agents: {},
    } as unknown as ConveyorConfig;
    store.upsertRepository({
      id: "repo",
      configName: "repo",
      source: "github",
      address: "owner/repo",
      folder: root,
      configHash: config.hash,
    });
    store.upsertIssue({
      id: "issue",
      repositoryId: "repo",
      sourceNumber: 1,
      sourceUrl: "https://github.com/owner/repo/issues/1",
      title: "Feature",
      body: "",
      sourceState: "open",
      labels: ["conveyor"],
      sourceUpdatedAt: "2026-09-29T00:00:00Z",
    });
    store.upsertIssue({
      id: "child",
      repositoryId: "repo",
      sourceNumber: 2,
      sourceUrl: "https://github.com/owner/repo/issues/2",
      title: "Child feature",
      body: "",
      sourceState: "open",
      labels: ["conveyor"],
      sourceUpdatedAt: "2026-09-29T00:00:00Z",
    });
    store.replaceRelationships("child", { parentId: "issue", siblingOrder: 1 }, []);
    store.createRun({
      id: "run-1",
      issueId: "issue",
      stageId: "implementation",
      attempt: 1,
      kind: "producer",
      status: "running",
      configHash: config.hash,
      startedAt: "2026-09-29T00:00:00Z",
    });
    const issue = store.getIssue("issue")!;
    const context: RuntimeIssueContext = {
      issue,
      repository: { id: "repo", address: "owner/repo", folder: root, baseBranch: "main" },
      workspace: { path: root, branch: "conveyor/1" },
      sourceGuidance: "Never close issues.",
    };
    const service = new ConveyorService(config, store, {} as never);
    const factory = (service as unknown as { mcpFactory(): ScopedMcpFactory }).mcpFactory();
    const lease = await factory.create({
      runId: "run-1",
      stageId: "implementation",
      context,
      allowedTools: ["conversation.get", "run.report_progress"],
      actor: { id: "implementer", name: "Implementer", title: "Senior Developer" },
    });
    const control = JSON.parse(await readFile(path.join(root, "artifacts/run-1/mcp-context.json"), "utf8")) as {
      control: { token: string };
    };
    await expect(
      service.postIssueMessage("issue", "Keep this backward compatible.", "operator"),
    ).resolves.toEqual({ status: "delivered", stageId: "implementation" });
    await service.handleMcp({
      tool: "run.report_progress",
      input: { message: "Compatibility is preserved; focused tests pass." },
    }, control.control.token);
    expect(await service.handleMcp({ tool: "conversation.get", input: {} }, control.control.token)).toMatchObject({
      messages: [
        { actorType: "user", message: "Keep this backward compatible." },
        { actorName: "Implementer", actorTitle: "Senior Developer", message: "Compatibility is preserved; focused tests pass." },
      ],
    });
    expect(store.listRunEvents("run-1")).toMatchObject([
      { type: "report_progress", payload: { message: "Compatibility is preserved; focused tests pass." } },
    ]);
    await lease.close();
    store.close();
  });

  test("atomically creates child issues with managed criteria and configured system labels", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-child-contract-"));
    temporaryDirectories.push(root);
    const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
    const config = {
      hash: "config-hash",
      root,
      settings: { artifacts: path.join(root, "artifacts"), workspaces: path.join(root, "workspaces") },
      web: { listen: "127.0.0.1:4300" },
      labels: {
        enrollment: "conveyor",
        stageTemplate: "conveyor:{stage}",
        states: { blocked: "conveyor:blocked" },
        metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" },
      },
      pipelines: {
        default: {
          stages: [
            { id: "refinement" },
            { id: "implementation" },
          ],
        },
      },
      repositories: {
        repo: {
          source: "github",
          address: "owner/repo",
          folder: root,
          baseBranch: "main",
          pipeline: "default",
          systemLabels: ["ci", "mobile", "web"],
        },
      },
      agents: {},
    } as unknown as ConveyorConfig;
    store.upsertRepository({
      id: "repo",
      configName: "repo",
      source: "github",
      address: "owner/repo",
      folder: root,
      configHash: config.hash,
    });
    store.upsertIssue({
      id: "parent",
      repositoryId: "repo",
      sourceNumber: 1,
      sourceUrl: "https://github.com/owner/repo/issues/1",
      title: "Parent",
      body: "Parent body",
      sourceState: "open",
      labels: ["conveyor", "conveyor:refinement"],
      sourceUpdatedAt: "2026-09-29T00:00:00Z",
    });
    store.createRun({
      id: "run-child",
      issueId: "parent",
      stageId: "refinement",
      attempt: 1,
      kind: "producer",
      status: "running",
      configHash: config.hash,
      startedAt: "2026-09-29T00:00:00Z",
    });
    let createInput: {
      address: string;
      parentNumber: number;
      title: string;
      body: string;
      labels: readonly string[];
    } | null = null;
    const github = {
      async createChildIssue(input: NonNullable<typeof createInput>) {
        createInput = input;
        return {
          id: "child",
          number: 2,
          url: "https://github.com/owner/repo/issues/2",
          title: input.title,
          body: input.body,
          state: "open" as const,
          stateReason: null,
          labels: [...input.labels],
          updatedAt: "2026-09-29T00:01:00Z",
        };
      },
    };
    const service = new ConveyorService(config, store, github as never);
    const factory = (service as unknown as { mcpFactory(): ScopedMcpFactory }).mcpFactory();
    const lease = await factory.create({
      runId: "run-child",
      stageId: "refinement",
      context: {
        issue: store.getIssue("parent")!,
        repository: { id: "repo", address: "owner/repo", folder: root, baseBranch: "main" },
        workspace: { path: root, branch: "conveyor/1" },
        sourceGuidance: "Create complete child contracts.",
      },
      allowedTools: ["source.create_child"],
      actor: { id: "refiner", name: "Refiner", title: "Product Owner" },
    });
    const control = JSON.parse(await readFile(path.join(root, "artifacts/run-child/mcp-context.json"), "utf8")) as {
      control: { token: string };
    };

    const child = await service.handleMcp({
      tool: "source.create_child",
      input: {
        title: "CI child",
        body: "Human-owned child context.",
        acceptanceCriteria: [
          { id: "AC-1", text: "Runs in GitHub Actions." },
          { id: "AC-2", text: "Uploads diagnostics.", completed: true },
        ],
        systemLabels: ["ci", "mobile", "not-configured"],
      },
    }, control.control.token) as { body: string; labels: string[] };

    expect(createInput).not.toBeNull();
    expect(createInput!.labels).toEqual([
      "conveyor",
      "conveyor:implementation",
      "ci",
      "mobile",
    ]);
    expect(parseManagedSections(createInput!.body).sections["acceptance-criteria"]).toBe(
      "- [ ] Runs in GitHub Actions. <!-- conveyor:criterion:AC-1 -->\n" +
      "- [x] Uploads diagnostics. <!-- conveyor:criterion:AC-2 -->",
    );
    expect(child.body).toBe(createInput!.body);
    expect(child.labels).toEqual([...createInput!.labels]);

    await lease.close();
    store.close();
  });

  test("moves a roll-up parent to the leftmost unfinished child stage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-relationships-"));
    temporaryDirectories.push(root);
    const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
    const config = {
      hash: "config-hash",
      root,
      settings: { workspaces: path.join(root, "workspaces"), runners: 3 },
      labels: {
        enrollment: "conveyor",
        stageTemplate: "conveyor:{stage}",
        states: { done: "conveyor:done", blocked: "conveyor:blocked" },
        metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" },
      },
      pipelines: {
        default: {
          stages: [
            { id: "refinement" },
            { id: "implementation" },
            { id: "review" },
          ],
        },
      },
      repositories: {
        repo: { source: "github", address: "owner/repo", folder: root, pipeline: "default" },
      },
    } as unknown as ConveyorConfig;
    store.upsertRepository({
      id: "repo",
      configName: "repo",
      source: "github",
      address: "owner/repo",
      folder: root,
      configHash: config.hash,
    });
    for (const issue of [
      { id: "parent", number: 1, stage: "refinement", state: "active", labels: ["conveyor", "conveyor:refinement", "conveyor:order:4"] },
      { id: "child", number: 2, stage: "implementation", state: "blocked", labels: ["conveyor", "conveyor:implementation", "conveyor:blocked"] },
      { id: "later-child", number: 3, stage: "review", state: "active", labels: ["conveyor", "conveyor:review"] },
      { id: "done-child", number: 4, stage: "refinement", state: "done", labels: ["conveyor", "conveyor:refinement", "conveyor:done"] },
    ]) {
      store.upsertIssue({
        id: issue.id,
        repositoryId: "repo",
        sourceNumber: issue.number,
        sourceUrl: `https://github.com/owner/repo/issues/${issue.number}`,
        title: issue.id,
        body: "",
        sourceState: "open",
        labels: issue.labels,
        sourceUpdatedAt: "2026-09-29T00:00:00Z",
      });
      store.setIssueProjection(issue.id, {
        stage: issue.stage,
        state: issue.state,
        warning: null,
      });
    }
    const sourceIssue = (
      id: string,
      number: number,
      labels: string[],
    ) => ({
      id,
      number,
      url: `https://github.com/new-owner/repo/issues/${number}`,
      title: id,
      body: "",
      state: "open" as const,
      stateReason: null,
      labels,
      updatedAt: "2026-09-29T00:00:00Z",
    });
    const replaced: Array<{ number: number; labels: readonly string[] }> = [];
    const source = {
      async listSubIssues(_address: string, number: number) {
        return number === 1
          ? [
              sourceIssue("github:new-owner/repo#2", 2, ["conveyor", "conveyor:implementation", "conveyor:blocked"]),
              sourceIssue("github:new-owner/repo#3", 3, ["conveyor", "conveyor:review"]),
              sourceIssue("github:new-owner/repo#4", 4, ["conveyor", "conveyor:refinement", "conveyor:done"]),
            ]
          : [];
      },
      async listDependencies(_address: string, number: number) {
        return number === 1
          ? [sourceIssue("github:new-owner/repo#2", 2, ["conveyor", "conveyor:implementation", "conveyor:blocked"])]
          : [];
      },
      async replaceConveyorLabels(_address: string, number: number, labels: readonly string[]) {
        replaced.push({ number, labels });
      },
    };
    const service = new ConveyorService(config, store, source as never);

    await (service as unknown as {
      reconcileRelationships(repositoryId: string, address: string): Promise<void>;
    }).reconcileRelationships("repo", "new-owner/repo");

    expect(store.listChildren("parent")).toEqual([
      { issueId: "child", siblingOrder: 1 },
      { issueId: "later-child", siblingOrder: 2 },
      { issueId: "done-child", siblingOrder: 3 },
    ]);
    expect(store.getIssue("child")?.parentId).toBe("parent");
    expect(store.listDependencies("parent")).toEqual(["child"]);
    expect(replaced).toEqual([{
      number: 1,
      labels: ["conveyor", "conveyor:implementation", "conveyor:order:4"],
    }]);
    expect(store.getStageState("parent")).toMatchObject({
      stageId: "implementation",
      status: "awaiting-source",
    });
    expect(store.listStageTransitions("parent")).toMatchObject([{
      fromStage: "refinement",
      toStage: "implementation",
      kind: "rollup",
      status: "completed",
    }]);
    store.close();
  });

  test("places untouched, staged, closed, and invalid issues in distinct lanes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-dashboard-"));
    temporaryDirectories.push(root);
    const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
    const config = {
      hash: "config-hash",
      root,
      settings: { workspaces: path.join(root, "workspaces"), runners: 3 },
      runners: { codex: { type: "codex" }, claude: { type: "claude-code" } },
      labels: {
        enrollment: "conveyor",
        stageTemplate: "conveyor:{stage}",
        states: { done: "conveyor:done", blocked: "conveyor:blocked" },
        metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" },
      },
      pipelines: {
        default: {
          stages: [
            { id: "refinement", run: { type: "agent", agent: "refiner" } },
            { id: "implementation", name: "Build", run: { type: "agent", agent: "implementer" } },
            {
              id: "ci",
              actions: [{ task: "agent.run", with: { agents: ["implementer", "refiner"] } }],
              exitGate: [{ task: "change.merged" }],
            },
          ],
        },
      },
      agents: {
        refiner: { name: "Refiner", title: "Product Owner", runner: "codex" },
        implementer: { name: "Implementer", title: "Senior Developer", runner: "claude" },
      },
      repositories: {
        earlier: { source: "github", address: "owner/earlier", folder: root, pipeline: "default" },
        repo: { source: "github", address: "owner/repo", folder: root, pipeline: "default" },
      },
    } as unknown as ConveyorConfig;
    store.upsertRepository({
      id: "repo",
      configName: "repo",
      source: "github",
      address: "owner/repo",
      folder: root,
      configHash: config.hash,
    });
    for (let number = 1; number <= 25; number += 1) {
      const id = `github:owner/repo#${number}`;
      store.upsertIssue({
        id,
        repositoryId: "repo",
        sourceNumber: number,
        sourceUrl: `https://github.com/owner/repo/issues/${number}`,
        title: `Done issue ${number}`,
        body: "",
        sourceState: "closed",
        sourceStateReason: "completed",
        labels: ["conveyor", "conveyor:done"],
        sourceUpdatedAt: `2026-09-29T00:${String(number).padStart(2, "0")}:00Z`,
      });
      store.setIssueProjection(id, {
        stage: null,
        state: "done",
        warning: number === 1
          ? "issue was closed before a correlated Conveyor PR merge"
          : null,
      });
    }
    store.replaceRelationships(
      "github:owner/repo#25",
      { parentId: "github:owner/repo#1", siblingOrder: 1 },
      [],
    );
    store.upsertIssue({
      id: "github:owner/repo#26",
      repositoryId: "repo",
      sourceNumber: 26,
      sourceUrl: "https://github.com/owner/repo/issues/26",
      title: "Untouched backlog issue",
      body: "",
      sourceState: "open",
      labels: ["conveyor"],
      sourceUpdatedAt: "2026-09-29T00:00:00Z",
    });
    store.setIssueProjection("github:owner/repo#26", {
      stage: "refinement",
      state: "active",
      warning: null,
    });
    store.setStageState({
      issueId: "github:owner/repo#26",
      stageId: "refinement",
      status: "ready",
      feedbackCycle: 0,
      configHash: config.hash,
    });
    store.upsertIssue({
      id: "github:owner/repo#27",
      repositoryId: "repo",
      sourceNumber: 27,
      sourceUrl: "https://github.com/owner/repo/issues/27",
      title: "Implementation issue",
      body: "",
      sourceState: "open",
      labels: ["conveyor", "conveyor:implementation"],
      sourceUpdatedAt: "2026-09-29T00:00:00Z",
    });
    store.setIssueProjection("github:owner/repo#27", {
      stage: "implementation",
      state: "active",
      warning: null,
    });
    store.replaceRelationships(
      "github:owner/repo#27",
      null,
      ["github:owner/repo#1"],
    );
    store.createRun({
      id: "active-run",
      issueId: "github:owner/repo#27",
      stageId: "implementation",
      attempt: 1,
      kind: "producer",
      status: "running",
      configHash: config.hash,
      startedAt: "2026-09-29T00:01:00Z",
    });
    store.appendRunEvent("active-run", "execution", { agentId: "implementer" });
    store.appendRunEvent("active-run", "harness", { type: "rate_limit_event", rate_limit_info: { unifiedWindows: {
      five_hour: { utilization: 0.14, resetsAt: "2026-10-03T18:30:00.000Z" },
    } } });
    for (let sequence = 1; sequence <= 7; sequence += 1) {
      store.appendRunEvent("active-run", "progress", { message: `Step ${sequence}` });
    }
    store.createRun({
      id: "older-run",
      issueId: "github:owner/repo#27",
      stageId: "implementation",
      attempt: 0,
      kind: "producer",
      status: "succeeded",
      configHash: config.hash,
      startedAt: "2026-09-29T00:00:30Z",
    });
    store.upsertIssue({
      id: "github:owner/repo#28",
      repositoryId: "repo",
      sourceNumber: 28,
      sourceUrl: "https://github.com/owner/repo/issues/28",
      title: "Open done issue without a stage",
      body: "",
      sourceState: "open",
      labels: ["conveyor", "conveyor:done"],
      sourceUpdatedAt: "2026-09-29T00:00:00Z",
    });
    store.setIssueProjection("github:owner/repo#28", {
      stage: null,
      state: "done",
      warning: null,
    });
    store.upsertIssue({
      id: "github:owner/repo#29",
      repositoryId: "repo",
      sourceNumber: 29,
      sourceUrl: "https://github.com/owner/repo/issues/29",
      title: "Closed by its merged PR while delivery continues",
      body: "",
      sourceState: "closed",
      sourceStateReason: "completed",
      labels: ["conveyor", "conveyor:implementation"],
      sourceUpdatedAt: "2026-09-29T01:00:00Z",
    });
    store.setIssueProjection("github:owner/repo#29", {
      stage: "implementation",
      state: "active",
      warning: null,
    });
    store.setStageState({
      issueId: "github:owner/repo#29",
      stageId: "implementation",
      status: "running",
      feedbackCycle: 0,
      configHash: config.hash,
    });
    store.upsertIssue({
      id: "github:owner/repo#30",
      repositoryId: "repo",
      sourceNumber: 30,
      sourceUrl: "https://github.com/owner/repo/issues/30",
      title: "Finished roll-up parent",
      body: "",
      sourceState: "open",
      labels: ["conveyor", "conveyor:implementation", "conveyor:done"],
      sourceUpdatedAt: "2026-09-29T02:00:00Z",
    });
    store.setIssueProjection("github:owner/repo#30", {
      stage: "implementation",
      state: "done",
      warning: null,
    });
    store.replaceRelationships(
      "github:owner/repo#27",
      { parentId: "github:owner/repo#30", siblingOrder: 1 },
      ["github:owner/repo#1"],
    );
    store.upsertIssue({
      id: "github:owner/repo#31",
      repositoryId: "repo",
      sourceNumber: 31,
      sourceUrl: "https://github.com/owner/repo/issues/31",
      title: "Waiting for CI",
      body: "",
      sourceState: "open",
      labels: ["conveyor", "conveyor:implementation"],
      sourceUpdatedAt: "2026-09-29T03:00:00Z",
    });
    store.setIssueProjection("github:owner/repo#31", {
      stage: "implementation",
      state: "active",
      warning: "Waiting for CI for 7c0ea55",
    });
    store.setStageState({
      issueId: "github:owner/repo#31",
      stageId: "implementation",
      status: "ready",
      feedbackCycle: 0,
      configHash: config.hash,
    });
    const journal = store.executions();
    const epoch = journal.stageEpoch("github:owner/repo#31");
    const pending = journal.planExecution({
      itemId: "github:owner/repo#31",
      stage: "implementation",
      stageEpoch: epoch,
      attempt: 1,
      list: "exit-gate",
      taskInstanceId: "ciGate",
    }).record;
    journal.markPending(pending.id, {
      wakeAt: "2026-09-29T03:12:00Z",
      deadlineAt: "2026-09-29T12:00:00Z",
      message: "Waiting for CI for 7c0ea55",
    }, epoch);
    journal.saveCursor({
      issueId: "github:owner/repo#31",
      stage: "implementation",
      stageEpoch: epoch,
      attempt: 1,
      returns: 0,
      list: "exit-gate",
      taskInstanceId: "ciGate",
      state: "pending",
      feedback: null,
      pendingSince: "2026-09-29T03:02:00Z",
      wakeAt: "2026-09-29T03:12:00Z",
      deadlineAt: "2026-09-29T12:00:00Z",
    }, epoch);

    const service = new ConveyorService(config, store, {} as never);
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(root, "empty-codex-home");
    const dashboard = service.dashboard("csrf", {
      view: "board",
      column: null,
      page: 1,
      doneLimit: 20,
      runId: null,
      issueId: "github:owner/repo#27",
    });
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    const implementation = dashboard.stages.find((column) => column.id === "stage:implementation");
    expect(dashboard.harnessUsage.map((harness) => harness.id)).toEqual(["codex", "claude"]);
    expect(dashboard.harnessUsage[0]?.windows).toEqual({});
    expect(dashboard.harnessUsage[1]?.windows.fiveHour?.remaining).toBeCloseTo(86);

    expect(dashboard.stages.map((column) => column.name)).toEqual(["Refinement", "Build", "CI"]);
    expect(implementation).toMatchObject({
      actors: [{ type: "agent", name: "Implementer", title: "Senior Developer" }],
      totalIssues: 3,
      page: 1,
      totalPages: 1,
    });
    expect(dashboard.stages.find((column) => column.id === "stage:ci")?.actors).toEqual([
      { type: "agent", name: "Implementer", title: "Senior Developer" },
      { type: "agent", name: "Refiner", title: "Product Owner" },
    ]);
    expect(implementation?.issues.map((issue) => issue.number)).toEqual([27, 29, 31]);
    expect(implementation?.issues[0]).toMatchObject({
      dependencies: [{ number: 1, satisfied: true }],
      working: true,
    });
    expect(implementation?.issues[1]).toMatchObject({ working: true });
    expect(implementation?.issues[2]).toMatchObject({
      activity: "implementation › ciGate",
      waiting: {
        reason: "Waiting for CI for 7c0ea55",
        since: "2026-09-29T03:02:00Z",
        nextCheckAt: "2026-09-29T03:12:00Z",
        deadline: "2026-09-29T12:00:00Z",
      },
    });
    expect(service.issueJourney("github:owner/repo#31")).toMatchObject({
      now: {
        stage: "implementation",
        state: "waiting",
        reason: "Waiting for CI for 7c0ea55",
        since: "2026-09-29T03:02:00Z",
      },
    });
    expect(dashboard.activeWork).toMatchObject({
      runnerCount: 2,
      runnerCapacity: 3,
      runs: [
        { id: "active-run", issueNumber: 27, stageId: "implementation", kind: "producer" },
        { issueNumber: 29, stageId: "implementation", kind: "orchestration" },
      ],
    });
    expect(dashboard.selectedIssue).toMatchObject({
      id: "github:owner/repo#27",
      repository: "repo",
      repositoryColor: 2,
    });
    expect(service.issueActivity("github:owner/repo#27")).toMatchObject({
      issueId: "github:owner/repo#27",
      runs: [{ id: "active-run" }],
      nextRunBefore: "active-run",
    });
    expect(service.issueActivity("github:owner/repo#27")?.runs).toHaveLength(1);
    expect(service.issueActivity("github:owner/repo#27")?.runs[0]?.events).toHaveLength(5);
    expect(service.issueActivity("github:owner/repo#27")?.runs[0]?.events[0]).toMatchObject({
      type: "progress",
      payload: { message: "Step 7" },
    });
    expect(dashboard.backlog.map((issue) => issue.number)).toEqual([26]);
    expect(dashboard.done).toMatchObject({ totalIssues: 26 });
    expect(dashboard.done.issues).toHaveLength(20);
    expect(dashboard.done.issues[0]).toMatchObject({
      number: 30,
      state: "done",
      tone: "success",
      inconsistent: false,
      children: [{ number: 27 }],
    });
    expect(dashboard.attention).toMatchObject({ name: "Label problems", totalIssues: 1 });
    expect(dashboard.attention.issues[0]).toMatchObject({
      number: 28,
      reason: "No valid configured stage label is present.",
    });
    expect(dashboard.counts).toEqual({ board: 4, attention: 1 });

    const expanded = service.dashboard("csrf", {
      view: "board",
      column: null,
      page: 1,
      doneLimit: 40,
      runId: null,
      issueId: null,
    });
    expect(expanded.done.issues).toHaveLength(26);
    store.close();
  });
});
