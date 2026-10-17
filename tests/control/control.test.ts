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
async function running() {
  const home = await shortTemporaryDirectory("conveyor-control-", { socketPath: "run/control.sock" });
  directories.push(home);
  log.configure({ sinks: [] });
  const store = await ConveyorStore.open(path.join(home, "state/conveyor.sqlite"));
  const config = {
    hash: "config-hash", root: home,
    settings: { artifacts: path.join(home, "artifacts"), workspaces: path.join(home, "worktrees"), runners: 2, labelPrefix: "conveyor", retention: { runHistoryMs: null, artifactsMs: null } },
    web: { listen: "127.0.0.1:7788" }, sources: { github: { type: "github" } },
    labels: {
      enrollment: "conveyor", stageTemplate: "conveyor:{stage}",
      states: { done: "conveyor:done", blocked: "conveyor:blocked", error: "conveyor:error", "needs-intervention": "conveyor:needs-intervention" },
      metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" },
    },
    pipelines: { default: { successStatuses: ["done"], failureStatuses: ["blocked"], stages: [{ id: "implementation", run: { type: "agent", agent: "implementer" }, concurrency: 1, failurePolicies: {}, afterSuccess: [] }] } },
    repositories: { app: { source: "github", address: "owner/app", folder: home, baseBranch: "main", pipeline: "default", concurrency: 1, systemLabels: [] } },
    agents: {},
  } as unknown as ConveyorConfig;
  store.upsertRepository({ id: "app", configName: "app", source: "github", address: "owner/app", folder: home, configHash: config.hash });
  const issues: FakeIssue[] = [1, 2].map((number) => ({
    id: `issue-${number}`, number, url: `https://github.com/owner/app/issues/${number}`, title: `Item ${number}`, body: "",
    state: "open", stateReason: null, labels: ["conveyor", "conveyor:implementation", "conveyor:blocked"], updatedAt: "2026-10-01T00:00:00Z",
  }));
  for (const issue of issues) {
    store.upsertIssue({ id: issue.id, repositoryId: "app", sourceNumber: issue.number, sourceUrl: issue.url, title: issue.title, body: "", sourceState: "open", sourceStateReason: null, labels: issue.labels, sourceUpdatedAt: issue.updatedAt });
    store.setQueueRank(issue.id, issue.number);
    store.setIssueProjection(issue.id, { stage: "implementation", state: "blocked", warning: "The agent needs the API key rotated" });
    store.setStageState({ issueId: issue.id, stageId: "implementation", status: "blocked", feedbackCycle: 0, configHash: config.hash });
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
    async listSubIssues() { return []; }, async listDependencies() { return []; },
    async upsertStatusComment() { return 1; }, async addComment() { return 1; },
  };
  const service = new ConveyorService(config, store, github as never);
  // Nothing executes in these tests: admission is drained, so retried and resumed items queue.
  service.drain("tests");
  const socket = path.join(home, "run/control.sock");
  const control = await serveControlSocket(socket, createControlHandler(service, {
    home, config: path.join(home, "config/conveyor.yaml"), logs: path.join(home, "logs"), database: path.join(home, "state/conveyor.sqlite"),
    dashboardUrl: "http://127.0.0.1:7788/", startedAt: "2026-10-06T10:00:00.000Z", supervised: false,
  }));
  cleanups.push(async () => { await control.stop(); store.close(); });
  const cli = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli([...argv, "--home", home], { out: (text) => out.push(text), err: (text) => err.push(text), environment: {}, interactive: false });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return { home, socket, store, service, issues, cli };
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
