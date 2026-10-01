import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ScopedMcpFactory } from "../../src/app/runtime";
import { ConveyorService } from "../../src/app/service";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore, type StoredIssue } from "../../src/db/store";
import type { Harness, HarnessRunInput } from "../../src/harness/types";
import { EMPTY_USAGE, UNAVAILABLE_COST, type RunEnvelope } from "../../src/runner/result";
import type { HarnessResumeInput } from "../../src/tasks/context";
import { createTaskRegistry } from "../../src/tasks/catalogue";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const CRITERIA = "<!-- conveyor:acceptance-criteria:start -->\n- [ ] It works <!-- conveyor:criterion:a -->\n<!-- conveyor:acceptance-criteria:end -->\n";

type Call = HarnessRunInput & HarnessResumeInput;

async function setup() {
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
  states: { done: "conveyor:done", blocked: "conveyor:blocked" }
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
  const github = {
    replaceConveyorLabels: async (_a: string, _n: number, labels: string[]) => { labelWrites.push([...labels]); },
    addComment: async (_a: string, _n: number, body: string) => { comments.push(body); return 1; },
  };

  const calls: Call[] = [];
  let sessionResume = true;
  const harness: Harness = {
    id: "fake",
    get capabilities() { return { sessionResume }; },
    async run(input): Promise<RunEnvelope> {
      calls.push(input);
      const runId = path.basename(input.artifactsDirectory);
      const first = calls.length === 1;
      if (first) store.openQuestion({ issueId: "issue", runId, prompt: "Which database?", reason: "need it", options: [] });
      return {
        stageResult: first
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
    sourceState: "open", labels: ["conveyor", "conveyor:refinement"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  store.setIssueProjection("issue", { stage: "refinement", state: "active", warning: null });
  store.setQueueRank("issue", store.nextQueueRank());
  store.setStageState({ issueId: "issue", stageId: "refinement", status: "ready", feedbackCycle: 0, configHash: config.hash });
  const enrollment = store.activateEnrollment("issue");
  const workspace = path.join(root, "ws");
  await mkdir(workspace);
  store.recordWorkspace({ id: "w1", enrollmentId: enrollment.id, path: workspace, branch: "conveyor/1", status: "active" });

  const execute = (signal = new AbortController().signal) =>
    (service as unknown as { execute(i: StoredIssue, s: AbortSignal): Promise<void> }).execute(store.getIssue("issue")!, signal);
  return { store, service, execute, calls, labelWrites, comments, root, setResume: (value: boolean) => { sessionResume = value; } };
}

describe("agent.run through the service", () => {
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
    await lease.close();
    await w.service.close();
  });
});
