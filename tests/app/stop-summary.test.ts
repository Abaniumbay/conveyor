import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import type { ConveyorConfig } from "../../src/config/load";
import { ConveyorStore } from "../../src/db/store";
import type { Harness, HarnessRunInput } from "../../src/harness/types";
import { codexProfile } from "../../src/plugins/codex/profile";
import { claudeCodeProfile } from "../../src/plugins/claude-code/profile";
import type { RunEnvelope } from "../../src/runner/result";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const ENVELOPE: RunEnvelope = {
  stageResult: { outcome: "success", status: "done", summary: "recorded", reason: null, metrics: {} },
  sessionId: "session", usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
  cost: { amount: 0, currency: "USD", source: "unavailable" }, durationMs: 1, exitCode: 0, artifacts: [], stderr: "",
};

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(options: { runner?: "codex" | "claude-code"; steering?: boolean; stopSummaryTimeoutMs?: number; run: (input: HarnessRunInput, fixture: () => Fixture) => Promise<RunEnvelope> }) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-stop-summary-"));
  temporaryDirectories.push(root);
  const instructions = path.join(root, "operator.md");
  await writeFile(instructions, "Operator instructions.");
  const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
  const runnerType = options.runner ?? "codex";
  const config = {
    hash: "config-hash", root,
    settings: { workspaces: path.join(root, "worktrees"), artifacts: path.join(root, "artifacts"), interruptGraceMs: 100, labelPrefix: "conveyor", retention: { runHistoryMs: null, artifactsMs: null } },
    web: { listen: "127.0.0.1:4300", ...(options.steering === false ? {} : { steering: { agent: "operator", workspace: root } }) },
    runners: { [runnerType]: runnerType === "codex"
      ? { type: "codex", command: "codex", sandbox: "workspace-write", automaticApprovals: true }
      : { type: "claude-code", command: "claude" } },
    labels: { enrollment: "conveyor", stageTemplate: "conveyor:{stage}", states: { blocked: "conveyor:blocked" }, metadata: { closable: "conveyor:closable", noSplit: "conveyor:no-split", paused: "conveyor:paused", orderTemplate: "conveyor:order:{number}" } },
    agents: { operator: { runner: runnerType, model: "model", effort: "high", instructions, workspaceAccess: "read-only", tasks: ["operator.getBoard", "operator.findItem", "operator.getItemHistory", "operator.retryItem", "operator.moveBacklogItem", "operator.retryStoppedItem", "operator.answerItemQuestion", "operator.reportStoppedItemOutcome", "operator.recordStopSummary"] } },
    pipelines: { default: { stages: [{ id: "implementation" }] } },
    repositories: { repo: { source: "github", address: "owner/repo", folder: root, baseBranch: "main", pipeline: "default", concurrency: 1, systemLabels: [] } },
    sources: { github: { type: "github" } }, checks: {}, ci: {},
  } as unknown as ConveyorConfig;
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/repo", folder: root, configHash: config.hash });
  store.upsertIssue({ id: "item", repositoryId: "repo", sourceNumber: 1, sourceUrl: "https://example.test/1", title: "Item", body: "", sourceState: "open", labels: ["conveyor", "conveyor:implementation", "conveyor:blocked"], sourceUpdatedAt: "2026-01-01T00:00:00Z" });
  store.setIssueProjection("item", { stage: "implementation", state: "blocked", warning: "CI failed" });
  const calls: HarnessRunInput[] = [];
  const harness = (): Harness => ({
    id: runnerType, capabilities: { sessionResume: false } as Harness["capabilities"],
    profile: runnerType === "codex" ? codexProfile : claudeCodeProfile,
    async run(input) { calls.push(input); return options.run(input, () => current); },
  });
  const service = new ConveyorService(config, store, {} as never, { harnesses: { [runnerType]: harness() }, ...(options.stopSummaryTimeoutMs ? { stopSummaryTimeoutMs: options.stopSummaryTimeoutMs } : {}) });
  const current = { root, store, config, service, calls, stop };
  function stop(id: string) {
    store.beginStageTransition({
      id, issueId: "item", fromStage: "implementation", toStage: "implementation", kind: "stopped", sourceMutationId: null,
      detail: { reason: "CI failed", requiredFixes: [], resultStatus: "blocked", sourceSnapshot: { title: "Item", body: "" } },
    });
    store.completeStageTransition(id);
  }
  return current;
}

async function token(input: HarnessRunInput): Promise<{ token: string; allowedTools: string[] }> {
  const context = JSON.parse(await readFile(input.mcp.args[input.mcp.args.indexOf("--context") + 1]!, "utf8")) as { control: { token: string }; allowedTools: string[] };
  return { token: context.control.token, allowedTools: context.allowedTools };
}

function snapshot(store: ConveyorStore) {
  const issue = store.getIssue("item")!;
  return { stage: issue.projectedStage, state: issue.projectedState, labels: issue.labels, warning: issue.warning, stopId: store.currentStopId("item") };
}

async function finish(f: Fixture): Promise<void> {
  await f.store.events().settled();
  await f.service.waitForStopSummaryRuns();
}

function failures(f: Fixture) {
  return f.calls.flatMap((call) => f.store.listRunEvents(path.basename(call.artifactsDirectory))).filter((event) => event.type === "operator.stopSummaryFailed");
}

const SUMMARY = "CI is failing: test `runs the string` in `tests/a.test.ts` expects `ok` and gets nothing.";

describe("stop-summary Operator run", () => {
  test("starts exactly one run per stop on a Claude Code runner, grants only read-only tools plus the recorder, and changes nothing else", async () => {
    let tokenValue = "";
    let allowed: string[] = [];
    const rejected: string[] = [];
    const f = await fixture({
      runner: "claude-code",
      async run(input, get) {
        const grant = await token(input);
        tokenValue = grant.token;
        allowed = grant.allowedTools;
        const { service } = get();
        for (const tool of ["operator.retryItem", "operator.answerItemQuestion", "operator.moveBacklogItem", "operator.reportStoppedItemOutcome", "operator.retryStoppedItem"]) {
          await service.handleMcp({ tool, input: { itemId: "item", note: "n", questionId: "q", answer: "a", evidence: "e", reason: "r", position: "up" } }, grant.token)
            .then(() => rejected.push(`${tool}: ran`), () => undefined);
        }
        await service.handleMcp({ tool: "operator.getItemHistory", input: { itemId: "item" } }, grant.token);
        await service.handleMcp({ tool: "operator.recordStopSummary", input: { itemId: "item", stopId: get().store.currentStopId("item"), summary: SUMMARY } }, grant.token);
        return ENVELOPE;
      },
    });
    f.stop("stop-1");
    const before = snapshot(f.store);
    await finish(f);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.sandbox).toBe("read-only");
    expect(f.calls[0]!.shell).toBe(false);
    expect(allowed.sort()).toEqual(["operator.findItem", "operator.getBoard", "operator.getItemHistory", "operator.recordStopSummary"]);
    expect(rejected).toEqual([]);
    expect(tokenValue).not.toBe("");
    expect(f.store.currentStopSummary("item")).toBe(SUMMARY);
    expect(snapshot(f.store)).toEqual(before);
    f.stop("stop-2");
    await finish(f);
    expect(f.calls).toHaveLength(2);
    await f.service.close();
  });

  test("starts no run when no steering agent is configured", async () => {
    const f = await fixture({ steering: false, run: async () => ENVELOPE });
    f.stop("stop-1");
    await finish(f);
    expect(f.calls).toHaveLength(0);
    expect(f.store.currentStopId("item")).toBe("stop-1");
    expect(f.store.currentStopSummary("item")).toBeNull();
    await f.service.close();
  });

  test("a failed run records its reason as an event and leaves no summary or other change", async () => {
    const f = await fixture({ run: async () => ({ ...ENVELOPE, stageResult: { ...ENVELOPE.stageResult, outcome: "failure", reason: "agent crashed" } }) });
    f.stop("stop-1");
    const before = snapshot(f.store);
    await finish(f);
    const events = failures(f);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ issueId: "item", stopId: "stop-1", kind: "failed", reason: "agent crashed" });
    expect(f.store.currentStopSummary("item")).toBeNull();
    expect(snapshot(f.store)).toEqual(before);
    await f.service.close();
  });

  test("a run that times out records the timeout reason and leaves no summary", async () => {
    const f = await fixture({
      stopSummaryTimeoutMs: 30,
      run: (input) => new Promise((_resolve, reject) => {
        input.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });
    f.stop("stop-1");
    const before = snapshot(f.store);
    await finish(f);
    const events = failures(f);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ kind: "timeout", reason: expect.stringContaining("timed out") });
    expect(f.store.currentStopSummary("item")).toBeNull();
    expect(snapshot(f.store)).toEqual(before);
    await f.service.close();
  });

  test("a run that fails after recording a summary removes that summary", async () => {
    const f = await fixture({
      async run(input, get) {
        const grant = await token(input);
        await get().service.handleMcp({ tool: "operator.recordStopSummary", input: { itemId: "item", stopId: get().store.currentStopId("item"), summary: SUMMARY } }, grant.token);
        throw new Error("agent crashed");
      },
    });
    f.stop("stop-1");
    await finish(f);
    expect(failures(f)).toHaveLength(1);
    expect(f.store.currentStopSummary("item")).toBeNull();
    await f.service.close();
  });
});
