import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import { EXIT } from "../../src/cli/args";
import { runCli } from "../../src/cli/main";
import type { ConveyorConfig } from "../../src/config/load";
import { createControlHandler, serveControlSocket } from "../../src/control/server";
import { ConveyorStore } from "../../src/db/store";
import { ConsoleSink, log, type LogRecord } from "../../src/log/logger";
import { createWebAuth, hashPassword } from "../../src/web/auth";
import { createWebHandler } from "../../src/web/server";
import { shortTemporaryDirectory } from "../support/short-temporary-directory";
import { fakeCommandBus } from "../support/web-commands";

const directories: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  log.configure({ sinks: [new ConsoleSink()] });
});

interface FakeIssue { id: string; number: number; url: string; title: string; body: string; state: "open" | "closed"; stateReason: null; labels: string[]; updatedAt: string }

/** A running service with a control socket under a fresh home, two stopped items and a fake GitHub. */
async function running(options: {
  rollup?: boolean;
  childCreationStage?: "implementation" | "refinement" | "work-breakdown";
  childCreationTask?: "item.createChild" | "breakdown.createChildren";
  includeChildImplementationStage?: boolean;
  ciRetryRoute?: boolean;
} = {}) {
  const { rollup = false, childCreationStage = "implementation", childCreationTask, includeChildImplementationStage = false, ciRetryRoute = false } = options;
  const stoppedStage = ciRetryRoute ? "ci-gate" : childCreationStage;
  const stoppedState = ciRetryRoute ? "needs-intervention" : "blocked";
  const home = await shortTemporaryDirectory("conveyor-control-", { socketPath: "run/control.sock" });
  directories.push(home);
  log.configure({ sinks: [] });
  const repository = path.join(home, "repository");
  if (childCreationTask) {
    await mkdir(repository);
    Bun.spawnSync(["git", "init", "-q", "-b", "main", repository]);
    Bun.spawnSync(["git", "-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial"]);
  }
  const store = await ConveyorStore.open(path.join(home, "state/conveyor.sqlite"));
  const config = {
    hash: "config-hash", root: home,
    settings: { artifacts: path.join(home, "artifacts"), workspaces: path.join(home, "worktrees"), runners: 2, retries: { infrastructureAttempts: 0, usageLimitAttempts: 0, minBackoff: 1, maxBackoff: 1 }, labelPrefix: "conveyor", retention: { runHistoryMs: null, artifactsMs: null } },
    web: { listen: "127.0.0.1:7788" }, sources: { github: { type: "github" } },
    labels: {
      enrollment: "conveyor", stageTemplate: "conveyor:{stage}",
      states: { done: "conveyor:done", blocked: "conveyor:blocked", error: "conveyor:error", "needs-intervention": "conveyor:needs-intervention" },
      metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" },
    },
    runners: {},
    plans: [],
    pipelines: { default: { successStatuses: ["done"], failureStatuses: ["blocked"], stages: [
      ...(ciRetryRoute ? [
        { id: "implementation", run: { type: "agent", agent: "implementer" }, concurrency: 1, failurePolicies: {}, afterSuccess: [] },
        { id: "ci-gate", run: { type: "agent", agent: "implementer" }, concurrency: 1, failurePolicies: {}, afterSuccess: [] },
      ] : [
        { id: childCreationStage, run: { type: "agent", agent: childCreationTask ? "worker" : "implementer" }, concurrency: 1, failurePolicies: {}, afterSuccess: [] },
      ]),
      ...(!ciRetryRoute && includeChildImplementationStage && childCreationStage !== "implementation"
        ? [{ id: "implementation", run: { type: "agent", agent: "implementer" }, concurrency: 1, failurePolicies: {}, afterSuccess: [] }]
        : []),
    ] } },
    repositories: { app: { source: "github", address: "owner/app", folder: childCreationTask ? repository : home, baseBranch: "main", pipeline: "default", concurrency: 1, systemLabels: [], ci: { mode: "disabled" } } },
    agents: childCreationTask ? { worker: { runner: "codex", instructions: path.join(home, "worker.md"), name: "Worker", title: "Builder", tasks: [childCreationTask] } } : {},
  } as unknown as ConveyorConfig;
  if (childCreationTask) await writeFile(path.join(home, "worker.md"), "Work.");
  store.upsertRepository({ id: "app", configName: "app", source: "github", address: "owner/app", folder: childCreationTask ? repository : home, configHash: config.hash });
  const issues: FakeIssue[] = [1, 2].map((number) => ({
    id: `issue-${number}`, number, url: `https://github.com/owner/app/issues/${number}`, title: `Item ${number}`, body: "",
    state: "open", stateReason: null, labels: ["conveyor", `conveyor:${stoppedStage}`, `conveyor:${stoppedState}`], updatedAt: "2026-10-01T00:00:00Z",
  }));
  for (const issue of issues) {
    store.upsertIssue({ id: issue.id, repositoryId: "app", sourceNumber: issue.number, sourceUrl: issue.url, title: issue.title, body: "", sourceState: "open", sourceStateReason: null, labels: issue.labels, sourceUpdatedAt: issue.updatedAt });
    store.setQueueRank(issue.id, issue.number);
    store.setIssueProjection(issue.id, { stage: stoppedStage, state: stoppedState, warning: "The agent needs the API key rotated" });
    store.setStageState({ issueId: issue.id, stageId: stoppedStage, status: stoppedState, feedbackCycle: 0, configHash: config.hash });
  }
  if (ciRetryRoute) {
    const id = "repeated-ci-failure";
    store.beginStageTransition({
      id, issueId: "issue-1", fromStage: "ci-gate", toStage: "ci-gate", kind: "stopped", sourceMutationId: null,
      detail: {
        reason: "The same required CI failure repeated.", requiredFixes: ["Repair the required check."], resultStatus: "needs-intervention",
        retryTargetStage: "implementation",
        retryFeedback: {
          from: { stage: "ci-gate", taskInstanceId: "ci.passed" }, message: "The same required CI failure repeated.",
          details: { evidence: ["required-ci-run"] },
        },
      },
    });
    store.completeStageTransition(id);
  }
  if (rollup) {
    const child: FakeIssue = {
      id: "issue-3", number: 3, url: "https://example.com/issues/3", title: "Child item", body: "",
      state: "open", stateReason: null, labels: ["conveyor", "conveyor:implementation"], updatedAt: "2026-10-01T00:00:00Z",
    };
    issues.push(child);
    store.upsertIssue({ id: child.id, repositoryId: "app", sourceNumber: child.number, sourceUrl: child.url, title: child.title, body: "", sourceState: "open", sourceStateReason: null, labels: child.labels, sourceUpdatedAt: child.updatedAt });
    store.setQueueRank(child.id, child.number);
    store.setIssueProjection(child.id, { stage: "implementation", state: "active", warning: null });
    store.setStageState({ issueId: child.id, stageId: "implementation", status: "active", feedbackCycle: 0, configHash: config.hash });
    store.replaceRelationships(child.id, { parentId: "issue-1", siblingOrder: null }, []);
  }
  const github = {
    async getIssue(_address: string, number: number) { return issues.find((issue) => issue.number === number)!; },
    async replaceConveyorLabels(_address: string, number: number, labels: readonly string[]) {
      const issue = issues.find((candidate) => candidate.number === number)!;
      issue.labels = [...labels, ...issue.labels.filter((label) => !label.startsWith("conveyor:") && label !== "conveyor")];
    },
    async listIssues() { return issues; },
    async getIssueProvenance() {
      return { enrollment: { login: "maintainer" }, title: { login: "maintainer" }, body: { login: "maintainer" } };
    },
    async collaboratorPermission() { return "write" as const; },
    async listSubIssues(_address: string, number: number) { return rollup && number === 1 ? [issues.find((issue) => issue.id === "issue-3")!] : []; }, async listDependencies() { return []; },
    async upsertStatusComment() { return 1; }, async addComment() { return 1; },
  };
  if (childCreationTask) {
    store.activateEnrollment("issue-1");
  }
  const service = new ConveyorService(config, store, github as never);
  // Most control tests keep admission drained; child-creation retries exercise the scheduler.
  if (!childCreationTask) service.drain("tests");
  const socket = path.join(home, "run/control.sock");
  const control = await serveControlSocket(socket, createControlHandler(service, {
    home, config: path.join(home, "config/conveyor.yaml"), logs: path.join(home, "logs"), database: path.join(home, "state/conveyor.sqlite"),
    dashboardUrl: "http://127.0.0.1:7788/", startedAt: "2026-10-06T10:00:00.000Z", supervised: false,
  }));
  cleanups.push(async () => { await control.stop(); await service.close(); });
  const cli = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli([...argv, "--home", home], { out: (text) => out.push(text), err: (text) => err.push(text), environment: {}, interactive: false });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return { home, socket, store, config, service, issues, cli };
}

describe("control socket", () => {
  test("reports the last hour's GitHub calls of the running service", async () => {
    const { service } = await running();
    service.githubCalls.record({ method: "GET", route: "repos/:repo/issues", repository: "owner/app", source: "tick", durationMs: 1, ok: true, status: null });
    const handler = createControlHandler(service, { supervised: false } as never);
    const report = await (await handler(new Request("http://x/v1/github-calls"))).json() as { total: number; bySource: Record<string, number>; rateLimit: unknown };
    expect(report).toMatchObject({ total: 1, bySource: { tick: 1 }, rateLimit: null });
  });

  test("CLI actions are commands sent by the CLI, and a retry's changes share its correlation id", async () => {
    const { store, cli } = await running();
    const after = store.events().latestSeq();
    expect((await cli("item", "pause", "app:2")).code).toBe(0);
    expect((await cli("item", "retry", "app:1")).code).toBe(0);
    const accepted = store.events().read({ afterSeq: after, type: "command.accepted" });
    expect(accepted.map((event) => [event.payload, event.actor.kind])).toEqual([
      [{ command: "item.pause" }, "cli"],
      [{ command: "item.retry" }, "cli"],
    ]);
    const retry = store.events().read({ correlationId: accepted[1]!.correlationId! }).map((event) => event.type);
    expect(retry).toContain("item.requeued");
    expect(retry.at(-1)).toBe("command.accepted");
  });


  test("is private to the service account and refuses a second live server; a stale socket is replaced", async () => {
    const { home, socket, service } = await running();
    expect((await stat(socket)).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(home, "run"))).mode & 0o777).toBe(0o700);
    await expect(serveControlSocket(socket, createControlHandler(service, {} as never))).rejects.toThrow("another Conveyor is already running");

    const stale = path.join(home, "run/stale.sock");
    const leftover = net.createServer().listen(stale);
    await new Promise((resolve) => leftover.once("listening", resolve));
    await new Promise<void>((resolve) => leftover.close(() => resolve()));
    await writeFile(stale, "").catch(() => {});
    const replaced = await serveControlSocket(stale, async () => new Response("ok"));
    expect(await (await fetch("http://x/", { unix: stale })).text()).toBe("ok");
    await replaced.stop();
  });

  test("a socket nobody listens on, or one the caller may not open, is explained rather than called stopped", async () => {
    const home = await shortTemporaryDirectory("conveyor-control-", { socketPath: "run/control.sock" });
    directories.push(home);
    const socket = path.join(home, "run/control.sock");
    await mkdir(path.dirname(socket), { recursive: true });
    // A process that bound the socket and died: the file stays, nothing listens.
    Bun.spawnSync(["python3", "-c", "import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])", socket]);
    const err: string[] = [];
    const run = () => runCli(["item", "show", "app:1", "--home", home], { out: () => {}, err: (text) => err.push(text), environment: {}, interactive: false });
    expect(await run()).toBe(EXIT.unavailable);
    expect(err.at(-1)).toContain("nothing is listening (the service stopped without removing its socket)");
    if (process.getuid?.() !== 0) {
      await chmod(path.dirname(socket), 0o000);
      try {
        expect(await run()).toBe(EXIT.unavailable);
        expect(err.at(-1)).toContain("permission denied. Run the command as the account that runs Conveyor");
      } finally {
        await chmod(path.dirname(socket), 0o700);
      }
    }
  });

  test("without a running service, status reports it and exits 4; item commands exit 4", async () => {
    const home = await shortTemporaryDirectory("conveyor-control-", { socketPath: "run/control.sock" });
    directories.push(home);
    const out: string[] = [];
    const code = await runCli(["status", "--home", home], { out: (text) => out.push(text), err: () => {}, environment: {}, interactive: false });
    expect(code).toBe(EXIT.unavailable);
    expect(out.join("\n")).toContain("Service: not running");
    const err: string[] = [];
    expect(await runCli(["item", "show", "app:1", "--home", home], { out: () => {}, err: (text) => err.push(text), environment: {}, interactive: false })).toBe(EXIT.unavailable);
    expect(err.join("\n")).toContain("Conveyor is not running for this home");
  });
});

describe("finding report", () => {
  async function seeded() {
    const world = await running();
    const db = world.store.sqlite();
    const run = (id: string, issueId: string, startedAt: string) => db.query("INSERT INTO runs(id, issue_id, stage_id, attempt, kind, status, config_hash, started_at, finished_at) VALUES (?, ?, 'review', 1, 'reviewer', 'succeeded', 'h', ?, ?)").run(id, issueId, startedAt, startedAt);
    const finding = (id: string, issueId: string, runId: string, type: string, at: string) => db.query("INSERT INTO findings(id, issue_id, run_id, provider_key, author, source, head_sha, state, body, created_at, type) VALUES (?, ?, ?, NULL, 'reviewer', 'agent', 'sha', 'open', 'b', ?, ?)").run(id, issueId, runId, at, type);
    run("r1", "issue-1", "2026-09-01T10:00:00.000Z");
    run("r2", "issue-1", "2026-10-02T10:00:00.000Z");
    finding("f1", "issue-1", "r1", "bug", "2026-09-01T10:00:00.000Z");
    finding("f2", "issue-1", "r2", "bug", "2026-10-02T10:00:00.000Z");
    finding("f3", "issue-2", "r2", "docs", "2026-10-02T10:00:00.000Z");
    return world;
  }

  test("prints the shared counts and review-round shares as text", async () => {
    const { cli } = await seeded();
    const result = await cli("report", "findings");
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain("Findings: 3");
    expect(result.out).toContain("Review rounds: 2");
    expect(result.out).toMatch(/bug\s+2\s+2\s+100\.0%/);
    expect(result.out).toMatch(/docs\s+1\s+1\s+50\.0%/);
  });

  test("--json emits the shared report", async () => {
    const { cli, store } = await seeded();
    const { buildFindingReport } = await import("../../src/app/finding-report");
    const result = await cli("report", "findings", "--json");
    expect(result.code).toBe(EXIT.ok);
    expect(JSON.parse(result.out)).toEqual(JSON.parse(JSON.stringify(buildFindingReport(store.sqlite()))));
    expect(JSON.parse(result.out)).toMatchObject({ total: 3, reviewRounds: 2, byType: { bug: 2, docs: 1 } });
  });

  test("--repository limits the result to that repository and rejects an unknown one", async () => {
    const { cli } = await seeded();
    expect(JSON.parse((await cli("report", "findings", "--repository", "app", "--json")).out)).toMatchObject({ total: 3, byRepository: { app: 3 } });
    const unknown = await cli("report", "findings", "--repository", "nope");
    expect(unknown.code).toBe(EXIT.usage);
    expect(unknown.err).toContain("nope");
  });

  test("--since includes only the selected window, inclusively", async () => {
    const { cli } = await seeded();
    const report = JSON.parse((await cli("report", "findings", "--since", "2026-10-02", "--json")).out) as { total: number; reviewRounds: number };
    expect(report).toMatchObject({ total: 2, reviewRounds: 1 });
    const exact = JSON.parse((await cli("report", "findings", "--since", "2026-10-02T10:00:00Z", "--json")).out) as { total: number };
    expect(exact.total).toBe(2);
    const later = JSON.parse((await cli("report", "findings", "--since", "2026-10-02T10:00:01Z", "--json")).out) as { total: number };
    expect(later.total).toBe(0);
  });

  test("an invalid --since is a CLI input error, and the service rejects one too", async () => {
    const { cli, service } = await seeded();
    for (const value of ["yesterday", "2026-13-45", "2026-10", "2026-02-30", "2026-04-31T10:00:00Z"]) {
      const result = await cli("report", "findings", "--since", value);
      expect(result.code).toBe(EXIT.usage);
      expect(result.err).toContain("ISO 8601");
    }
    const handler = createControlHandler(service, { supervised: false } as never);
    expect((await handler(new Request("http://x/v1/reports/findings?since=yesterday"))).status).toBe(400);
  });
});

describe("restart route", () => {
  test("a supervised service refuses to restart over running work unless forced", async () => {
    let restarts = 0;
    const service = { activeWork: () => ({ items: [{ issueId: "i", repositoryId: "app", stageId: "implementation" }], steering: 0 }), commands: fakeCommandBus({}).commands };
    const handler = createControlHandler(service as never, { supervised: true } as never, { restart: () => { restarts += 1; } });
    const restart = (body: unknown) => handler(new Request("http://x/v1/restart", { method: "POST", body: JSON.stringify(body) }));
    const refused = await restart({});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "work is still running: drain first, or force the restart" });
    const forced = await restart({ force: true });
    expect(await forced.json()).toEqual({ restarting: true });
    await Bun.sleep(80);
    expect(restarts).toBe(1);
  });
});

describe("operating through the CLI", () => {
  test("status shows only the first paragraph of a long stop reason", async () => {
    const { cli, store } = await running();
    const excerpt = "(fail) dashboard live refresh position > keeps Recent usable";
    store.setIssueProjection("issue-1", { stage: "implementation", state: "blocked", warning: `The same required CI failure repeated. Another automatic retry will not fix it.\n\nFirst failure: https://example.com/pull/1 at abc1234.\n\n\`\`\`\n${excerpt}\n\`\`\`` });
    const result = await cli("status");
    expect(result.out).toContain("app:1 implementation blocked: The same required CI failure repeated. Another automatic retry will not fix it.");
    expect(result.out).not.toContain(excerpt);
  });

  test("status shows capacity, stopped items with their blocker, and paths", async () => {
    const { cli, home } = await running();
    const result = await cli("status");
    expect(result.code).toBe(0);
    expect(result.out).toContain("Dashboard: http://127.0.0.1:7788/");
    expect(result.out).toContain(`Home: ${home}`);
    expect(result.out).toContain("Runners: 0 of 2 busy");
    expect(result.out).toContain("Stopped items: 2");
    expect(result.out).toContain("app:1 implementation blocked:");
    const json = JSON.parse((await cli("status", "--json")).out) as { running: boolean; service: { stopped: unknown[]; artifacts: string; temporary: string }; disk: Record<string, number>; filesystems: Array<{ name: string; location: string }> };
    expect(json.running).toBe(true);
    expect(json.service.stopped).toHaveLength(2);
    expect(json.filesystems).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "artifacts", location: json.service.artifacts }),
      expect.objectContaining({ name: "temporary", location: json.service.temporary }),
    ]));
    expect(Object.keys(json.disk)).toContain("state");
  });

  test("board and item show explain the stage, the concrete blocker and the recovery actions", async () => {
    const { cli } = await running();
    const board = await cli("board");
    expect(board.out).toMatch(/app:1\s+implementation\s+blocked\s+Item 1/);
    const shown = await cli("item", "show", "app:1");
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("Stage: implementation   State: stopped");
    expect(shown.out).toContain("Blocker: The agent needs the API key rotated");
    expect(shown.out).toContain("retry the implementation stage: conveyor item retry app:1");
    expect(shown.out).toContain("pause it: conveyor item pause app:1");
    expect((await cli("item", "show", "app:99")).code).toBe(EXIT.failure);
  });

  test("item retry follows a repeated CI gate's configured return stage through the control socket", async () => {
    const { cli, issues, service, store } = await running({ ciRetryRoute: true });
    const shown = await cli("item", "show", "app:1");
    expect(shown.out).toContain("retry to implementation: conveyor item retry app:1");
    expect(service.issueDetails("control-token", "issue-1")).toMatchObject({ retryTargetStage: "implementation" });

    const retried = await cli("item", "retry", "app:1");
    expect(retried.code).toBe(EXIT.ok);
    expect(issues[0]!.labels).toEqual(["conveyor", "conveyor:implementation"]);
    expect(store.getIssue("issue-1")).toMatchObject({ projectedStage: "implementation", projectedState: "active" });
  });

  test("the authenticated dashboard retry endpoint follows a repeated CI gate's configured return stage", async () => {
    const { issues, service, store } = await running({ ciRetryRoute: true });
    const auth = createWebAuth({
      passwordHash: hashPassword("correct horse", { salt: "0123456789abcdef" }),
      sessionSecret: "session-secret-that-is-at-least-thirty-two-bytes",
    });
    const session = auth.createSession({ id: "operator", username: "operator", role: "superuser", avatar: "🛠️", sessionVersion: 1 })!;
    const handler = createWebHandler(service.webDependencies(auth, "operator"));
    const response = await handler(new Request("http://localhost/api/issues/issue-1/retry", {
      method: "POST",
      headers: { cookie: session.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: session.csrfToken }),
    }));

    expect(response.status).toBe(202);
    expect(issues[0]!.labels).toEqual(["conveyor", "conveyor:implementation"]);
    expect(store.getIssue("issue-1")).toMatchObject({ projectedStage: "implementation", projectedState: "active" });
  });

  test("item show reports a pre-stage dependency wait and clears it without changing the projection", async () => {
    const { cli, store } = await running();
    store.setIssueProjection("issue-1", { stage: "implementation", state: "active", warning: null });
    store.setStageState({ issueId: "issue-1", stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: "config-hash" });
    store.upsertIssue({
      id: "blocker", repositoryId: "app", sourceNumber: 3, sourceUrl: "https://example.com/3", title: "Blocker", body: "",
      sourceState: "open", sourceStateReason: null, labels: ["conveyor", "conveyor:implementation"], sourceUpdatedAt: "2026-10-01T00:00:00Z",
    });
    store.setIssueProjection("blocker", { stage: "implementation", state: "active", warning: null });
    store.replaceRelationships("issue-1", null, ["blocker"]);
    const before = store.getIssue("issue-1")!;

    const waiting = await cli("item", "show", "app:1");
    expect(waiting.out).toContain("Stage: implementation   State: Waiting");
    expect(waiting.out).toContain("Blocker: Waiting for dependencies: #3");

    store.upsertIssue({
      id: "blocker", repositoryId: "app", sourceNumber: 3, sourceUrl: "https://example.com/3", title: "Blocker", body: "",
      sourceState: "closed", sourceStateReason: null, labels: ["conveyor", "conveyor:implementation"], sourceUpdatedAt: "2026-10-02T00:00:00Z",
    });
    const cleared = await cli("item", "show", "app:1");
    expect(cleared.out).toContain("Stage: implementation   State: active");
    expect(cleared.out).not.toContain("Waiting for dependencies");
    expect(store.getIssue("issue-1")).toMatchObject({
      projectedStage: before.projectedStage,
      projectedState: before.projectedState,
      labels: before.labels,
    });
  });

  test("dashboard and item show share a full capacity explanation and clear it after release", async () => {
    const { cli, config, service, store } = await running();
    config.settings.runners = 1;
    store.setIssueProjection("issue-1", { stage: "implementation", state: "active", warning: null });
    store.setStageState({ issueId: "issue-1", stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: config.hash });
    store.setIssueProjection("issue-2", { stage: "implementation", state: "active", warning: null });
    store.setStageState({ issueId: "issue-2", stageId: "implementation", status: "running", feedbackCycle: 0, configHash: config.hash });
    const reason = "global runner slots 1/1 busy: #2; implementation slots 1/1 busy: #2; app slots 1/1 busy: #2";
    const before = store.getIssue("issue-1")!;

    expect(service.dashboard("csrf", { view: "board", column: null, page: 1, doneLimit: 20, runId: null, issueId: "issue-1" }).selectedIssue)
      .toMatchObject({ state: "active", waiting: { kind: "queued", reason }, reason: null });
    expect(service.issueDetails("csrf", "issue-1")).toMatchObject({ waiting: { kind: "queued", reason }, reason: null });
    const queued = await cli("item", "show", "app:1");
    expect(queued.out).toContain("Stage: implementation   State: Queued");
    expect(queued.out).toContain(`Blocker: ${reason}`);

    store.setStageState({ issueId: "issue-2", stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: config.hash });
    expect(service.dashboard("csrf", { view: "board", column: null, page: 1, doneLimit: 20, runId: null, issueId: "issue-1" }).selectedIssue)
      .toMatchObject({ state: "active", waiting: null, reason: null });
    const cleared = await cli("item", "show", "app:1");
    expect(cleared.out).toContain("Stage: implementation   State: active");
    expect(cleared.out).not.toContain("busy:");
    expect(store.getIssue("issue-1")).toMatchObject({
      projectedStage: before.projectedStage,
      projectedState: before.projectedState,
      labels: before.labels,
    });
  });

  test("roll-up parents advertise and resume waiting rather than retrying a parent stage", async () => {
    const { cli, store, issues } = await running({ rollup: true });
    const shown = await cli("item", "show", "app:1");
    expect(shown.out).toContain("resume waiting for children: conveyor item resume-waiting app:1");
    expect(shown.out).toContain("Children can keep running while this parent waits.");
    expect(shown.out).not.toContain("conveyor item retry app:1");
    expect((await cli("item", "retry", "app:1")).code).toBe(EXIT.rejected);

    const after = store.events().latestSeq();
    const resumed = await cli("item", "resume-waiting", "app:1");
    expect(resumed.out).toBe("app:1: resumed waiting for children at implementation.");
    expect(issues[0]!.labels).toEqual(["conveyor", "conveyor:implementation"]);
    expect(store.getIssue("issue-1")).toMatchObject({ projectedState: "active", projectedStage: "implementation" });
    expect(store.listActiveIssueRuns().filter((run) => run.issueId === "issue-1")).toEqual([]);
    expect(store.getIssue("issue-3")?.projectedState).toBe("active");
    expect(store.events().read({ afterSeq: after, type: "command.accepted" }).map((event) => event.payload)).toEqual([{ command: "item.resumeRollup" }]);
  });

  test("retry starts a stopped custom refinement parent with an existing child", async () => {
    const { cli, service, store } = await running({
      rollup: true,
      childCreationStage: "refinement",
      childCreationTask: "item.createChild",
      includeChildImplementationStage: true,
    });
    const shown = await cli("item", "show", "app:1");
    expect(shown.out).toContain("retry the refinement stage: conveyor item retry app:1");
    expect(shown.out).not.toContain("conveyor item resume-waiting app:1");

    const retried = await cli("item", "retry", "app:1");
    expect(retried.code).toBe(0);
    expect(store.getIssue("issue-1")).toMatchObject({ projectedState: "active" });
    expect(store.getIssue("issue-1")).toMatchObject({ projectedStage: "refinement", labels: ["conveyor", "conveyor:refinement"] });
    expect(service.activeWork().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId: "issue-1", stageId: "refinement" }),
    ]));
  });

  test("retry starts a stopped work-breakdown parent with an existing child", async () => {
    const { cli, service, store } = await running({
      rollup: true,
      childCreationStage: "work-breakdown",
      childCreationTask: "breakdown.createChildren",
      includeChildImplementationStage: true,
    });

    const retried = await cli("item", "retry", "app:1");
    expect(retried.code).toBe(0);
    expect(store.getIssue("issue-1")).toMatchObject({ projectedStage: "work-breakdown", labels: ["conveyor", "conveyor:work-breakdown"] });
    expect(service.activeWork().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId: "issue-1", stageId: "work-breakdown" }),
    ]));
  });

  test("retry reports the stage and whether it started or queued; a refusal exits 5 with the reason", async () => {
    const { cli, store, issues } = await running();
    const retried = await cli("item", "retry", "app:1", "--note", "rotated the key");
    expect(retried.err).toBe("");
    expect(retried.out).toBe("app:1: implementation queued (it starts when capacity and dependencies allow).");
    expect(issues[0]!.labels).toEqual(["conveyor", "conveyor:implementation"]);
    expect(store.listConversationMessages("issue-1").find((message) => message.actorType === "user")).toMatchObject({ message: "rotated the key", actorName: expect.stringContaining("(CLI)") });
    const again = await cli("item", "retry", "app:1");
    expect(again.code).toBe(EXIT.rejected);
    expect(again.err).toContain("refresh before retrying");
  });

  test("pause removes only the enrollment label; resume restores it and reports the stage", async () => {
    const { cli, store, issues } = await running();
    const paused = await cli("item", "pause", "app:2");
    expect(paused.out).toBe("app:2 paused at implementation.");
    expect(issues[1]!.labels).toEqual(["conveyor:implementation", "conveyor:blocked"]);
    expect((await cli("item", "show", "app:2")).out).toContain("resume it: conveyor item resume app:2");
    expect((await cli("item", "pause", "app:2")).code).toBe(EXIT.rejected);
    const resumed = await cli("item", "resume", "app:2", "--json");
    expect(JSON.parse(resumed.out)).toMatchObject({ item: "app:2", stageId: "implementation" });
    expect(issues[1]!.labels).toContain("conveyor");
    expect(store.listConversationMessages("issue-2").map((message) => message.message).join("\n")).toMatch(/Paused by .*\(CLI\)[\s\S]*Resumed by/);
  });

  describe("pausing a stage-less refinement item", () => {
    async function stageless() {
      const world = await running({ childCreationStage: "refinement" });
      const issue = world.issues[0]!;
      issue.labels = ["conveyor"];
      world.store.upsertIssue({ id: issue.id, repositoryId: "app", sourceNumber: 1, sourceUrl: issue.url, title: issue.title, body: "", sourceState: "open", sourceStateReason: null, labels: issue.labels, sourceUpdatedAt: issue.updatedAt });
      await world.service.syncRepository("app");
      const board = async (service = world.service) => {
        const response = await createControlHandler(service, { supervised: false } as never)(new Request("http://x/v1/board"));
        return (await response.json()) as Array<{ item: string; stage: string | null; state: string }>;
      };
      return { ...world, issue, board };
    }

    test("stays listed as paused on the board, and resumes into refinement", async () => {
      const { cli, issue, board, store } = await stageless();
      expect((await board()).find((entry) => entry.item === "app:1")).toMatchObject({ stage: "refinement", state: "active" });
      expect((await cli("item", "pause", "app:1")).code).toBe(0);
      expect(issue.labels).toEqual([]);
      expect((await board()).find((entry) => entry.item === "app:1")).toMatchObject({ state: "paused" });
      expect((await cli("item", "resume", "app:1")).code).toBe(0);
      expect(issue.labels).toContain("conveyor");
      expect((await board()).find((entry) => entry.item === "app:1")).toMatchObject({ stage: "refinement", state: expect.not.stringMatching(/paused|offboarded/) });
      expect(store.getIssue("issue-1")!.pausedByConveyor).toBe(false);
    });

    test("keeps an unanswered question open and the item paused, across pause, restart and resume", async () => {
      const { cli, issue, board, store, home, config } = await stageless();
      const question = store.openQuestion({ issueId: "issue-1", runId: null, prompt: "Which region?", reason: "two are configured", options: ["eu", "us"] });
      expect((await cli("item", "pause", "app:1")).code).toBe(0);
      expect((await board()).find((entry) => entry.item === "app:1")).toMatchObject({ state: "paused" });
      expect(store.getQuestion(question.id)?.status).toBe("open");

      const reopened = await ConveyorStore.open(path.join(home, "state/conveyor.sqlite"));
      const github = { async getIssue() { return issue; }, async listIssues() { return [issue]; }, async listSubIssues() { return []; }, async listDependencies() { return []; }, async getIssueProvenance() { return { enrollment: { login: "maintainer" }, title: { login: "maintainer" }, body: { login: "maintainer" } }; }, async collaboratorPermission() { return "write" as const; } };
      const restarted = new ConveyorService(config, reopened, github as never);
      restarted.drain("tests");
      cleanups.push(async () => { await restarted.close(); });
      await restarted.syncRepository("app");
      expect((await board(restarted)).find((entry) => entry.item === "app:1")).toMatchObject({ state: "paused" });
      expect(reopened.getQuestion(question.id)?.status).toBe("open");

      expect((await cli("item", "resume", "app:1")).code).toBe(0);
      expect(issue.labels).toContain("conveyor");
      expect(store.getQuestion(question.id)?.status).toBe("open");
    });

    test("is offboarded when a person removes every label without pausing", async () => {
      const { service, issue, board, store } = await stageless();
      issue.labels = [];
      await service.syncRepository("app");
      expect(store.getIssue("issue-1")!.projectedState).toBe("offboarded");
      expect((await board()).find((entry) => entry.item === "app:1")).toBeUndefined();
    });
  });

  test("questions are listed and answered through the same operation as the dashboard", async () => {
    const { cli, store } = await running();
    const question = store.openQuestion({ issueId: "issue-1", runId: null, prompt: "Which region?", reason: "two are configured", options: ["eu", "us"] });
    const listed = await cli("questions", "list");
    expect(listed.out).toContain(`${question.id}  app:1`);
    expect(listed.out).toContain("options: eu | us");
    const answered = await cli("questions", "answer", question.id, "eu");
    expect(answered.out).toBe(`Answered ${question.id} for app:1.`);
    expect(store.getQuestion(question.id)?.status).not.toBe("open");
    expect(store.listConversationMessages("issue-1").filter((message) => message.questionId === question.id)).toEqual([
      expect.objectContaining({ actorName: expect.stringContaining("(CLI)"), message: expect.stringContaining("**Question:** Which region?\n\n**Accepted answer:** eu") }),
    ]);
    expect((await cli("questions", "answer", question.id, "us")).code).toBe(EXIT.rejected);
  });

  test("questions with legacy value choices accept their value and label through the CLI", async () => {
    const { cli, store } = await running();
    const first = store.openQuestion({
      issueId: "issue-1", runId: null, prompt: "Which commit?", reason: "choose a baseline",
      options: [{ label: "Current main commit", value: "current-main" }], allowFreeText: false,
    });
    expect((await cli("questions", "list")).out).toContain('"value":"current-main"');
    expect((await cli("questions", "answer", first.id, "current-main")).code).toBe(EXIT.ok);
    expect(store.getQuestion(first.id)?.answer).toEqual({ answer: "current-main" });

    const second = store.openQuestion({
      issueId: "issue-1", runId: null, prompt: "Which commit?", reason: "choose a baseline",
      options: [{ label: "Current main commit", value: "current-main" }], allowFreeText: false,
    });
    expect((await cli("questions", "answer", second.id, "Current main commit")).code).toBe(EXIT.ok);
    expect(store.getQuestion(second.id)?.answer).toEqual({ answer: "current-main" });

    const invalid = store.openQuestion({
      issueId: "issue-1", runId: null, prompt: "Which commit?", reason: "choose a baseline",
      options: [{ label: "Current main commit", value: "current-main" }], allowFreeText: false,
    });
    expect((await cli("questions", "answer", invalid.id, "unknown")).code).toBe(EXIT.rejected);
    expect(store.getQuestion(invalid.id)?.status).toBe("open");
  });

  test("offboarded questions are hidden and cannot be answered", async () => {
    const { cli, store, issues } = await running();
    const question = store.openQuestion({ issueId: "issue-1", runId: null, prompt: "Which region?", reason: "two are configured", options: ["eu", "us"] });
    store.setIssueProjection("issue-1", { stage: null, state: "offboarded", warning: null });
    const labelsBefore = [...issues[0]!.labels];

    expect(JSON.parse((await cli("questions", "list", "--json")).out)).toEqual([]);
    expect(JSON.parse((await cli("status", "--json")).out).service).toMatchObject({ openQuestions: 0, stopped: [{ item: "app:2" }] });
    expect((await cli("board")).out).not.toContain("app:1");
    expect((await cli("item", "show", "app:1")).code).toBe(EXIT.failure);

    const answer = await cli("questions", "answer", question.id, "eu");
    expect(answer.code).toBe(EXIT.rejected);
    expect(answer.err).toContain("offboarded");
    expect(store.getQuestion(question.id)).toMatchObject({ status: "open", answer: null });
    expect(store.listConversationMessages("issue-1").filter((message) => message.questionId === question.id)).toEqual([]);
    expect(issues[0]!.labels).toEqual(labelsBefore);
  });

  test("item logs prints the run history from a cursor", async () => {
    const { cli, store } = await running();
    store.createRun({ id: "run-1", issueId: "issue-1", stageId: "implementation", attempt: 1, kind: "producer", status: "completed", configHash: "config-hash", startedAt: "2026-10-06T10:00:00Z" });
    store.appendRunEvent("run-1", "report_progress", { message: "tests written" });
    store.appendRunEvent("run-1", "tool", { name: "ci.getLogs" });
    const logs = await cli("item", "logs", "app:1");
    expect(logs.out.split("\n")).toEqual([
      expect.stringMatching(/\[implementation\/producer\] report_progress: tests written$/),
      expect.stringMatching(/\[implementation\/producer\] tool: \{"name":"ci\.getLogs"\}$/),
    ]);
  });

  test("cleanup through the running service reports and reclaims terminal run homes", async () => {
    const { cli, home, store } = await running();
    store.createRun({ id: "finished", issueId: "issue-1", stageId: "implementation", attempt: 1, kind: "implementer", status: "running", configHash: "config-hash", startedAt: "2026-10-06T10:00:00Z" });
    store.finishRun("finished", {
      status: "completed", exitCode: 0, result: { outcome: "success" }, sessionId: null,
      finishedAt: "2026-10-06T10:01:00Z",
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, amount: 0, currency: "USD", source: "test", durationMs: 1 },
    });
    store.createRun({ id: "active", issueId: "issue-1", stageId: "implementation", attempt: 2, kind: "implementer", status: "running", configHash: "config-hash", startedAt: "2026-10-06T10:02:00Z" });
    const finishedHome = path.join(home, "artifacts/finished/home");
    const activeHome = path.join(home, "artifacts/active/home");
    await mkdir(finishedHome, { recursive: true });
    await mkdir(activeHome, { recursive: true });
    await writeFile(path.join(finishedHome, "session.jsonl"), "x".repeat(1200));
    await writeFile(path.join(home, "artifacts/finished/result.json"), "recorded result");
    await writeFile(path.join(activeHome, "session.jsonl"), "active");

    const dryRun = await cli("cleanup", "--dry-run");
    expect(dryRun.code).toBe(EXIT.ok);
    expect(dryRun.out).toContain("Would delete 1 run home");
    expect(await readFile(path.join(finishedHome, "session.jsonl"), "utf8")).toHaveLength(1200);

    const reclaimed = await cli("cleanup", "--json");
    expect(reclaimed.code).toBe(EXIT.ok);
    expect(JSON.parse(reclaimed.out)).toMatchObject({ homes: { directories: 1, bytes: 1200, failures: [] } });
    await expect(stat(finishedHome)).rejects.toThrow();
    expect(await readFile(path.join(home, "artifacts/finished/result.json"), "utf8")).toBe("recorded result");
    expect(await readFile(path.join(activeHome, "session.jsonl"), "utf8")).toBe("active");
    expect(store.getRun("finished")).toMatchObject({ status: "completed", result: { outcome: "success" } });
  });

  test("automatic cleanup warns when it cannot reclaim a terminal run home", async () => {
    const { home, service, store } = await running();
    store.createRun({ id: "unreclaimed", issueId: "issue-1", stageId: "implementation", attempt: 1, kind: "implementer", status: "running", configHash: "config-hash", startedAt: "2026-10-06T10:00:00Z" });
    store.finishRun("unreclaimed", {
      status: "completed", exitCode: 0, result: { outcome: "success" }, sessionId: null,
      finishedAt: "2026-10-06T10:01:00Z",
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, amount: 0, currency: "USD", source: "test", durationMs: 1 },
    });
    const outside = path.join(home, "outside");
    await mkdir(outside);
    await mkdir(path.join(home, "artifacts"));
    await symlink(outside, path.join(home, "artifacts", "unreclaimed"));
    const records: LogRecord[] = [];
    log.configure({ sinks: [{ write: (record) => records.push(record) }] });

    const report = await service.applyRetention();
    const repeated = await service.applyRetention();

    expect(report.homes.failures).toHaveLength(1);
    expect(report.homes.failures[0]).toContain("unreclaimed:");
    expect(repeated.homes.failures).toEqual([]);
    expect(records.filter((record) => record.level === "warn" && record.message === "Could not reclaim some terminal run homes")).toHaveLength(1);
  });

  test("a drain stops admission and steering until it is lifted; the restart route needs systemd", async () => {
    const { cli, service, socket } = await running();
    expect(service.resumeAdmission()).toBe(true);
    const drained = await fetch("http://x/v1/drain", { unix: socket, method: "POST", body: JSON.stringify({ reason: "upgrade" }) });
    expect(await drained.json()).toMatchObject({ draining: { reason: "upgrade" } });
    expect((await cli("status")).out).toContain("draining since");
    await expect(service.startSteering("hello")).rejects.toThrow("draining");
    const restart = await fetch("http://x/v1/restart", { unix: socket, method: "POST" });
    expect(restart.status).toBe(409);
    expect(await (await fetch("http://x/v1/drain", { unix: socket, method: "DELETE" })).json()).toEqual({ resumed: true });
    expect(service.draining()).toBeNull();
  });
});
