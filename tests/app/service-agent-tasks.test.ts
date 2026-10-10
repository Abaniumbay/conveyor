import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ScopedMcpFactory } from "../../src/app/runtime";
import { ConveyorService } from "../../src/app/service";
import { loadConfig } from "../../src/config/load";
import { ReviewFindings } from "../../src/engine/review-findings";
import { ConveyorStore, type StoredIssue } from "../../src/db/store";
import type { Harness, HarnessRunInput } from "../../src/harness/types";
import { ConsoleSink, log } from "../../src/log/logger";
import { EMPTY_USAGE, UNAVAILABLE_COST, type RunEnvelope } from "../../src/runner/result";
import type { HarnessResumeInput } from "../../src/tasks/context";
import { createTaskRegistry } from "../../src/tasks/catalogue";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const CRITERIA = "<!-- conveyor:acceptance-criteria:start -->\n- [ ] It works <!-- conveyor:criterion:a -->\n<!-- conveyor:acceptance-criteria:end -->\n";

type Call = HarnessRunInput & HarnessResumeInput;

async function setup(options: { noWorkspace?: boolean; needsInput?: boolean; questionOptions?: unknown[]; allowFreeText?: boolean; waitForAbort?: boolean; waitForRelease?: boolean; completeAfterRelease?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-agent-service-"));
  directories.push(root);
  const repositoryPath = path.join(root, "repo");
  await mkdir(repositoryPath);
  await writeFile(path.join(root, "worker.md"), "Work.");
  await writeFile(path.join(root, "config.yml"), `
settings:
  database: ${root}/db.sqlite
  logs: ${root}/logs
  workspaces: ${root}/workspaces
  artifacts: ${root}/artifacts
web: {}
sources: { github: { type: github } }
runners: { codex: { type: codex } }
agents: { worker: { runner: codex, instructions: ./worker.md, name: Worker, title: Builder } }
labels:
  enrollment: conveyor
  stageTemplate: "conveyor:{stage}"
  states: { done: "conveyor:done", blocked: "conveyor:blocked"${options.needsInput ? ', "needs-input": "conveyor:needs-input"' : ""} }
  metadata: { closable: "conveyor:closable", orderTemplate: "conveyor:order:{number}" }
pipelines:
  default:
    stages:
      - id: refinement
        concurrency: 1
        retries: 0
        actions: [{ task: agent.run, with: { agent: worker } }]
        exit-gate: [{ task: item.criteriaDefined }]
      - id: implementation
        concurrency: 1
        actions: []
        exit-gate: [{ task: item.criteriaDefined }]
repositories:
  repo:
    source: github
    address: owner/repo
    folder: ${repositoryPath}
    pipeline: default
`);
  const config = await loadConfig(path.join(root, "config.yml"), createTaskRegistry());
  const store = await ConveyorStore.open(config.settings.database);
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: repositoryPath, configHash: config.hash });
  const labelWrites: string[][] = [];
  const comments: string[] = [];
  let failComments = 0;
  const github = {
    replaceConveyorLabels: async (_a: string, _n: number, labels: string[]) => { labelWrites.push([...labels]); },
    hasCommentWithMarker: async (_a: string, _n: number, marker: string) => comments.some((comment) => comment.includes(marker)),
    addComment: async (_a: string, _n: number, body: string) => {
      if (failComments > 0) { failComments -= 1; throw new Error("temporary source outage"); }
      comments.push(body); return 1;
    },
  };

  const calls: Call[] = [];
  let sessionResume = true;
  let started: (() => void) | null = null;
  const running = new Promise<void>((resolve) => { started = resolve; });
  let release: (() => void) | null = null;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const harness: Harness = {
    id: "fake",
    get capabilities() { return { sessionResume }; },
    async run(input): Promise<RunEnvelope> {
      calls.push(input);
      if (options.waitForRelease) {
        started!();
        await released;
      }
      if (options.waitForAbort) {
        started!();
        await new Promise<never>((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(input.signal?.reason ?? new Error("interrupted")), { once: true });
        });
      }
      const runId = path.basename(input.artifactsDirectory);
      const first = calls.length === 1;
      if (first && !options.completeAfterRelease) store.openQuestion({
        issueId: "issue", runId, prompt: "Which database?", reason: "need it",
        options: options.questionOptions ?? [], allowFreeText: options.allowFreeText ?? true,
      });
      return {
        stageResult: first && !options.completeAfterRelease
          ? { outcome: "failure", status: "needs-input", summary: "Asked", reason: "Which database?", metrics: {} }
          : { outcome: "success", status: "done", summary: "Done", reason: null, metrics: {} },
        sessionId: "sess-1", usage: { ...EMPTY_USAGE }, cost: { ...UNAVAILABLE_COST }, durationMs: 1, exitCode: 0, artifacts: [], stderr: "",
      };
    },
  };
  const service = new ConveyorService(config, store, github as never, { harnesses: { codex: harness } });
  Object.assign(service as object, { reconcileRepository: async () => {}, updateStatusComment: async () => {}, schedule: () => {} });

  store.upsertIssue({
    id: "issue", repositoryId: "repo", sourceNumber: 1, sourceUrl: "https://example.test/1", title: "Issue", body: CRITERIA,
    sourceState: "open", labels: ["conveyor", "conveyor:refinement", ...(options.needsInput ? ["conveyor:needs-input"] : [])], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  store.setIssueProjection("issue", { stage: "refinement", state: "active", warning: null });
  store.setQueueRank("issue", store.nextQueueRank());
  store.setStageState({ issueId: "issue", stageId: "refinement", status: "ready", feedbackCycle: 0, configHash: config.hash });
  const enrollment = store.activateEnrollment("issue");
  const workspace = path.join(root, "ws");
  const created: Array<Record<string, unknown>> = [];
  if (options.noWorkspace) {
    Object.assign(service as object, {
      workspaceManager: {
        create: async (input: Record<string, unknown>) => { created.push(input); await mkdir(workspace, { recursive: true }); return { path: workspace, branch: "conveyor/1-issue" }; },
        restore: async () => {}, remove: async () => {},
      },
    });
  } else {
    await mkdir(workspace);
    store.recordWorkspace({ id: "w1", enrollmentId: enrollment.id, path: workspace, branch: "conveyor/1", status: "active" });
  }

  const execute = (signal = new AbortController().signal) =>
    (service as unknown as { execute(i: StoredIssue, s: AbortSignal): Promise<void> }).execute(store.getIssue("issue")!, signal);
  const schedule = () => (Object.getPrototypeOf(service) as { schedule(this: unknown): void }).schedule.call(service);
  return { config, store, service, execute, schedule, running, release: () => release!(), calls, created, workspace, labelWrites, comments, root, failNextComment: () => { failComments += 1; }, setResume: (value: boolean) => { sessionResume = value; } };
}

describe("agent.run through the service", () => {
  test("interrupts a running agent stage for restart and queues the same workspace again", async () => {
    const first = await setup({ waitForAbort: true });
    const logs: string[] = [];
    const onboard = ConveyorService.prototype.onboardRepositories;
    const reconcile = ConveyorService.prototype.reconcileAll;
    const resumed: string[] = [];
    log.configure({ sinks: [{ write: (record) => logs.push(JSON.stringify(record)) }] });
    ConveyorService.prototype.onboardRepositories = async () => {};
    ConveyorService.prototype.reconcileAll = async () => {};
    try {
      first.schedule();
      await first.running;
      first.service.drain("restart test");
      await first.service.close();

      const interrupted = await ConveyorStore.open(path.join(first.root, "db.sqlite"));
      expect(interrupted.getStageState("issue")).toMatchObject({ status: "interrupted" });
      expect(interrupted.listIssueRuns("issue")[0]).toMatchObject({ status: "interrupted" });
      expect(interrupted.getIssue("issue")).toMatchObject({ projectedState: "active" });
      expect(interrupted.getActiveWorkspace("issue")).toMatchObject({ path: first.workspace });
      interrupted.close();

      const service = await ConveyorService.create(first.config, {} as never, {} as never);
      (service as unknown as { execute(issue: StoredIssue): Promise<void> }).execute = async (issue) => { resumed.push(issue.id); };
      service.start();
      while (resumed.length === 0) await Bun.sleep(5);

      expect(resumed).toEqual(["issue"]);
      expect(service.store.getStageState("issue")).toMatchObject({ status: "ready", stageId: "refinement" });
      expect(service.store.getActiveWorkspace("issue")).toMatchObject({ path: first.workspace });
      expect(service.store.listIssueRuns("issue")).toHaveLength(1);
      expect(service.store.listIssueRuns("issue")[0]).toMatchObject({ status: "interrupted" });
      expect(logs).toContainEqual(expect.stringContaining('"message":"Stage waiting during drain"'));
      expect(logs).toContainEqual(expect.stringContaining('"message":"Stage interrupted during shutdown"'));
      expect(logs).toContainEqual(expect.stringContaining('"message":"Stage queued after restart"'));
      expect(logs).toContainEqual(expect.stringContaining('"item":"repo:1"'));
      await service.close();
    } finally {
      ConveyorService.prototype.onboardRepositories = onboard;
      ConveyorService.prototype.reconcileAll = reconcile;
      log.configure({ sinks: [new ConsoleSink()] });
    }
  });

  test("keeps control available for a stage that finishes during a graceful drain", async () => {
    const w = await setup({ waitForRelease: true, completeAfterRelease: true });
    const logs: string[] = [];
    log.configure({ sinks: [{ write: (record) => logs.push(JSON.stringify(record)) }] });
    try {
      w.schedule();
      await w.running;
      w.service.drain("release test");
      w.release();
      while (w.service.activeWork().items.length > 0) await Bun.sleep(5);

      expect(w.store.getStageState("issue")).toMatchObject({ stageId: "implementation", status: "awaiting-source" });
      expect(w.store.listIssueRuns("issue")[0]).toMatchObject({ status: "succeeded" });
      expect(logs).toContainEqual(expect.stringContaining('"message":"Stage finished during drain"'));
    } finally {
      await w.service.close();
      log.configure({ sinks: [new ConsoleSink()] });
    }
  });

  test("a native stage whose first action is agent.run gets a workspace on an item that has none", async () => {
    const w = await setup({ noWorkspace: true });
    expect(w.store.getActiveWorkspace("issue")).toBeNull();
    w.setResume(true);
    // The fake harness asks first; the second call completes. Run until the agent has been invoked in a workspace.
    await w.execute();
    expect(w.created).toHaveLength(1);
    expect(w.store.getActiveWorkspace("issue")).toMatchObject({ path: w.workspace, branch: "conveyor/1-issue" });
    expect(w.calls[0]!.workspace).toBe(w.workspace);
    await w.service.close();
  });

  test("passes the run's abort signal, parks on a question and continues the session after the answer", async () => {
    const w = await setup();
    const controller = new AbortController();
    await w.execute(controller.signal);
    expect(w.calls[0]!.signal).toBe(controller.signal);
    const journal = w.store.executions();
    expect(journal.getCursor("issue")).toMatchObject({ stage: "refinement", taskInstanceId: "agent.run", state: "pending" });
    expect(Date.parse(journal.wakeAt("issue")!)).toBeGreaterThan(Date.now() + 30_000);
    expect(w.store.getIssue("issue")?.warning).toBe("Waiting for an answer: Which database?");
    expect(w.store.getStageState("issue")?.status).toBe("ready");

    const question = w.store.listOpenQuestions()[0]!;
    await w.service.answerQuestion(question.id, "PostgreSQL");
    expect(Date.parse(journal.wakeAt("issue")!)).toBeLessThanOrEqual(Date.now());
    expect(journal.getCursor("issue")).toMatchObject({ state: "pending", stage: "refinement" });
    expect(w.labelWrites).toEqual([]);
    expect(w.comments[0]).toContain("PostgreSQL");

    await w.execute();
    expect(w.calls).toHaveLength(2);
    expect(w.calls[1]).toMatchObject({ resumeSessionId: "sess-1", answeredQuestion: { question: "Which database?", answer: "PostgreSQL" } });
    expect(w.labelWrites.at(-1)).toContain("conveyor:implementation");
    await w.service.close();
  });

  test("an owner message answers the open question and wakes the parked item", async () => {
    const w = await setup();
    await w.execute();
    const result = await w.service.postIssueMessage("issue", "PostgreSQL please", "operator");
    expect(result.stageId).toBe("refinement");
    expect(result.status).not.toBe("delivered");
    expect(w.store.listOpenQuestions()).toEqual([]);
    expect(Date.parse(w.store.executions().wakeAt("issue")!)).toBeLessThanOrEqual(Date.now());
    expect(w.labelWrites).toEqual([]);
    await w.service.close();
  });

  test("normalizes a choice-label conversation reply before recording it and rejects invalid replies", async () => {
    const w = await setup({
      questionOptions: [{ id: " postgres ", label: " PostgreSQL " }],
      allowFreeText: false,
    });
    await w.execute();
    await expect(w.service.postIssueMessage("issue", "not one of the choices", "operator")).rejects.toThrow("Choose one of the available answers.");
    expect(w.store.listConversationMessages("issue").some((entry) => entry.actorType === "user")).toBe(false);

    await w.service.postIssueMessage("issue", "postgresql", "operator");
    expect(w.store.getQuestion(w.store.listOpenQuestions()[0]?.id ?? "missing")).toBeNull();
    expect(w.comments[0]).toContain("postgres");
    await w.service.close();
  });

  test("keeps a saved answer retryable until its source mirror succeeds", async () => {
    const w = await setup();
    await w.execute();
    const question = w.store.listOpenQuestions()[0]!;
    w.failNextComment();
    await expect(w.service.answerQuestion(question.id, "PostgreSQL")).rejects.toThrow("saved but could not be mirrored");
    expect(w.store.getQuestion(question.id)).toMatchObject({ status: "open", answer: { answer: "PostgreSQL" } });
    await w.service.answerQuestion(question.id, "PostgreSQL");
    expect(w.store.getQuestion(question.id)?.status).toBe("answered");
    expect(w.comments).toHaveLength(1);
    await expect(w.service.answerQuestion(question.id, "PostgreSQL")).rejects.toThrow("already been answered");
    await w.service.close();
  });

  test("clears the configured needs-input label before waking the parked refinement", async () => {
    const w = await setup({ needsInput: true });
    await w.execute();
    await w.service.answerQuestion(w.store.listOpenQuestions()[0]!.id, "PostgreSQL");
    expect(w.labelWrites.at(-1)).toEqual(["conveyor", "conveyor:refinement"]);
    expect(Date.parse(w.store.executions().wakeAt("issue")!)).toBeLessThanOrEqual(Date.now());
    await w.service.close();
  });

  test("wakes the parked refinement when reconciliation after an answer is temporarily unavailable", async () => {
    const w = await setup();
    await w.execute();
    Object.assign(w.service as object, { reconcileRepository: async () => { throw new Error("temporary source outage"); } });

    const question = w.store.listOpenQuestions()[0]!;
    await w.service.answerQuestion(question.id, "PostgreSQL");
    expect(w.store.getQuestion(question.id)?.status).toBe("answered");
    expect(Date.parse(w.store.executions().wakeAt("issue")!)).toBeLessThanOrEqual(Date.now());
    expect(w.store.getIssue("issue")).toMatchObject({ projectedState: "active", warning: null });
    await w.service.close();
  });

  test("recognizes a stale pending mirror that reached the source and does not duplicate its comment", async () => {
    const w = await setup();
    await w.execute();
    const question = w.store.listOpenQuestions()[0]!;
    w.store.recordQuestionAnswer(question.id, "web", { answer: "PostgreSQL" });
    w.store.beginSourceMutation({
      idempotencyKey: `question-answer:${question.id}`, source: "github", operation: "issue.comment.answer", request: {},
    });
    w.comments.push(`<!-- conveyor:answer:${question.id} -->\n**Conveyor answer:** PostgreSQL`);

    await w.service.answerQuestion(question.id, "PostgreSQL");
    expect(w.store.getQuestion(question.id)?.status).toBe("answered");
    expect(w.comments).toHaveLength(1);
    await w.service.close();
  });

  test("keeps a live answer mirror single-flight while allowing stale mutations to recover", async () => {
    const w = await setup();
    await w.execute();
    const question = w.store.listOpenQuestions()[0]!;
    let releaseComment: (() => void) | undefined;
    let markCommentStarted: (() => void) | undefined;
    const commentStarted = new Promise<void>((resolve) => { markCommentStarted = resolve; });
    Object.assign((w.service as unknown as { github: object }).github, {
      async addComment(_address: string, _number: number, markdown: string) {
        markCommentStarted?.();
        await new Promise<void>((resolve) => { releaseComment = resolve; });
        w.comments.push(markdown);
        return 1;
      },
    });

    const first = w.service.answerQuestion(question.id, "PostgreSQL");
    await commentStarted;
    await expect(w.service.answerQuestion(question.id, "PostgreSQL")).rejects.toThrow("already being recorded");
    releaseComment?.();
    await first;

    expect(w.store.getQuestion(question.id)?.status).toBe("answered");
    expect(w.comments).toHaveLength(1);
    await w.service.close();
  });

  test("holds child scheduling until its parent's answered refinement leaves refinement", async () => {
    const w = await setup();
    await w.execute();
    w.store.upsertIssue({
      id: "child", repositoryId: "repo", sourceNumber: 2, sourceUrl: "https://example.test/2", title: "Child", body: CRITERIA,
      sourceState: "open", labels: ["conveyor", "conveyor:refinement"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    w.store.setIssueProjection("child", { stage: "refinement", state: "active", warning: null });
    w.store.setQueueRank("child", w.store.nextQueueRank());
    w.store.setStageState({ issueId: "child", stageId: "refinement", status: "ready", feedbackCycle: 0, configHash: "test" });
    w.store.replaceRelationships("child", { parentId: "issue", siblingOrder: 1 }, []);

    const candidates = () => (w.service as unknown as { schedulerCandidates(): Array<{ id: string; eligible: boolean }> }).schedulerCandidates();
    expect(candidates().find((candidate) => candidate.id === "child")?.eligible).toBe(false);

    await w.service.answerQuestion(w.store.listOpenQuestions()[0]!.id, "PostgreSQL");
    expect(candidates().find((candidate) => candidate.id === "child")?.eligible).toBe(false);

    await w.execute();
    // Relationship roll-up may project the parent back to the child frontier,
    // but the successful refinement transition remains the scheduler boundary.
    w.store.setIssueProjection("issue", { stage: "refinement", state: "active", warning: null });
    expect(candidates().find((candidate) => candidate.id === "child")?.eligible).toBe(true);
    await w.service.close();
  });
});

describe("answering a question for a stage not parked on agent.run", () => {
  test("restarts the stage instead of waking it", async () => {
    const w = await setup();
    await w.execute();
    const journal = w.store.executions();
    const parked = journal.getCursor("issue")!;
    // Parked on a different task of the same stage: not ours to wake.
    journal.saveCursor({ ...parked, list: "exit-gate", taskInstanceId: "item.criteriaDefined" }, parked.stageEpoch);
    const before = journal.wakeAt("issue");
    await w.service.answerQuestion(w.store.listOpenQuestions()[0]!.id, "PostgreSQL");
    expect(journal.wakeAt("issue")).toBe(before);
    expect(w.labelWrites.at(-1)).toContain("conveyor:refinement");
    await w.service.close();
  });
});

describe("legacy MCP names delegate to the agent tools", () => {
  test("run.* and conversation.get behave as before, and both artifact names record one event type", async () => {
    const w = await setup();
    const issue = w.store.getIssue("issue")!;
    const factory = (w.service as unknown as { mcpFactory(): ScopedMcpFactory }).mcpFactory();
    w.store.createRun({ id: "run-1", issueId: "issue", stageId: "refinement", attempt: 1, kind: "producer", status: "running", configHash: "h", startedAt: new Date().toISOString() });
    const lease = await factory.create({
      runId: "run-1", stageId: "refinement",
      context: { issue, repository: { id: "repo", address: "owner/repo", folder: w.root, baseBranch: "main" }, workspace: null, sourceGuidance: "g" } as never,
      allowedTools: ["run.report_progress", "run.ask_question", "run.record_artifact", "workspace.record_artifact", "run.report_rationale", "conversation.get"],
      actor: { id: "worker", name: "Worker", title: "Builder" },
    });
    const token = (JSON.parse(await readFile(path.join(w.root, "artifacts/run-1/mcp-context.json"), "utf8")) as { control: { token: string } }).control.token;
    const call = (tool: string, input: unknown) => w.service.handleMcp({ tool, input }, token);

    expect(await call("run.report_progress", { message: "Halfway" })).toEqual({ accepted: true });
    const asked = await call("run.ask_question", { prompt: "Which?", reason: "r", options: ["a", "b"], allowFreeText: true }) as { accepted: boolean; questionId: string };
    expect(w.store.getQuestion(asked.questionId)).toMatchObject({ runId: "run-1", prompt: "Which?", options: ["a", "b"], allowFreeText: true });
    expect(await call("run.record_artifact", { name: "a" })).toEqual({ accepted: true });
    expect(await call("workspace.record_artifact", { name: "b" })).toEqual({ accepted: true });
    expect(await call("run.report_rationale", { why: "x" })).toEqual({ accepted: true });
    expect(await call("conversation.get", { limit: 5 })).toMatchObject({ issueId: "issue", messages: [{ actorName: "Worker", message: "Halfway" }] });
    expect(w.store.listRunEvents("run-1").map((e) => e.type)).toEqual(["report_progress", "question", "record_artifact", "record_artifact", "report_rationale"]);

    await w.service.handleMcp({ tool: "agent.reportProgress", input: { message: "Exactly once" } }, token, "lost-response");
    await w.service.handleMcp({ tool: "agent.reportProgress", input: { message: "Exactly once" } }, token, "lost-response");
    expect(w.store.listConversationMessages("issue").filter((message) => message.message === "Exactly once")).toHaveLength(1);
    await lease.close();
    await w.service.close();
  });
});

describe("operator dismissal of findings", () => {
  test("dismisses through the dispatcher as the signed-in human and audits it", async () => {
    const w = await setup();
    const findings = new ReviewFindings(w.store.sqlite());
    const finding = findings.create({ issueId: "issue", runId: "run-1", author: "worker", headSha: "h1", body: "Fix" });
    await w.service.dismissFinding("issue", finding.id, "Not applicable here", "operator");
    expect(findings.get("issue", finding.id)).toMatchObject({ state: "dismissed", dismissal: { actor: "human:operator", reason: "Not applicable here" } });
    expect(findings.events(finding.id).at(-1)).toMatchObject({ kind: "dismissed", actor: "human:operator" });
    await expect(w.service.dismissFinding("issue", finding.id, "again", "operator")).rejects.toThrow("not open");
    await expect(w.service.dismissFinding("missing", finding.id, "x", "operator")).rejects.toThrow("issue not found");
    await w.service.close();
  });

  test("wakes an item parked on its exit gate so the gate re-evaluates", async () => {
    const w = await setup();
    await w.execute();
    const journal = w.store.executions();
    const parked = journal.getCursor("issue")!;
    journal.saveCursor({ ...parked, list: "exit-gate", taskInstanceId: "change.findingsResolved" }, parked.stageEpoch);
    const finding = new ReviewFindings(w.store.sqlite()).create({ issueId: "issue", runId: null, author: "worker", headSha: "h1", body: "Fix" });
    const future = Date.now() + 3_600_000;
    w.store.sqlite().query("UPDATE stage_cursors SET wake_at = ? WHERE issue_id = 'issue'").run(new Date(future).toISOString());
    await w.service.dismissFinding("issue", finding.id, "Not applicable", "operator");
    expect(Date.parse(journal.wakeAt("issue")!)).toBeLessThanOrEqual(Date.now());
    await w.service.close();
  });
});
