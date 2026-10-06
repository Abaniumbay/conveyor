import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import { EXIT } from "../../src/cli/args";
import { runCli } from "../../src/cli/main";
import type { ConveyorConfig } from "../../src/config/load";
import { createControlHandler, serveControlSocket } from "../../src/control/server";
import { ConveyorStore } from "../../src/db/store";
import { ConsoleSink, log } from "../../src/log/logger";

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
  const home = await mkdtemp(path.join(tmpdir(), "conveyor-control-"));
  directories.push(home);
  log.configure({ sinks: [] });
  const store = await ConveyorStore.open(path.join(home, "state/conveyor.sqlite"));
  const config = {
    hash: "config-hash", root: home,
    settings: { artifacts: path.join(home, "artifacts"), workspaces: path.join(home, "worktrees"), runners: 2, labelPrefix: "conveyor" },
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
    async listIssues() { return issues; }, async listSubIssues() { return []; }, async listDependencies() { return []; },
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
    const code = await runCli([...argv, "--home", home], { out: (text) => out.push(text), err: (text) => err.push(text), environment: {} });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return { home, socket, store, service, issues, cli };
}

describe("control socket", () => {
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
    const home = await mkdtemp(path.join(tmpdir(), "conveyor-control-"));
    directories.push(home);
    const socket = path.join(home, "run/control.sock");
    await mkdir(path.dirname(socket), { recursive: true });
    // A process that bound the socket and died: the file stays, nothing listens.
    Bun.spawnSync(["python3", "-c", "import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])", socket]);
    const err: string[] = [];
    const run = () => runCli(["item", "show", "app:1", "--home", home], { out: () => {}, err: (text) => err.push(text), environment: {} });
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
    const home = await mkdtemp(path.join(tmpdir(), "conveyor-control-"));
    directories.push(home);
    const out: string[] = [];
    const code = await runCli(["status", "--home", home], { out: (text) => out.push(text), err: () => {}, environment: {} });
    expect(code).toBe(EXIT.unavailable);
    expect(out.join("\n")).toContain("Service: not running");
    const err: string[] = [];
    expect(await runCli(["item", "show", "app:1", "--home", home], { out: () => {}, err: (text) => err.push(text), environment: {} })).toBe(EXIT.unavailable);
    expect(err.join("\n")).toContain("Conveyor is not running for this home");
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
    const json = JSON.parse((await cli("status", "--json")).out) as { running: boolean; service: { stopped: unknown[] }; disk: Record<string, number> };
    expect(json.running).toBe(true);
    expect(json.service.stopped).toHaveLength(2);
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
    expect((await cli("questions", "answer", question.id, "us")).code).toBe(EXIT.rejected);
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
