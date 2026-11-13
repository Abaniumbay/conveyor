// agent.run with a pi runner: the real pi harness launches a fake pi CLI (under a pass-through
// bwrap), so the correction and fallback paths run through pi's own error kinds and sessions.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ConveyorConfig } from "../../../src/config/load";
import { ConveyorStore } from "../../../src/db/store";
import type { Harness, HarnessRunInput } from "../../../src/harness/types";
import { claudeCodeProfile } from "../../../src/plugins/claude-code/profile";
import { piHarness } from "../../../src/plugins/pi/harness";
import { EMPTY_USAGE, UNAVAILABLE_COST } from "../../../src/runner/result";
import { createTaskRegistry } from "../../../src/tasks/catalogue";
import type { TaskContext } from "../../../src/tasks/context";
import { runTask, type TaskResult } from "../../../src/tasks/contract";
import type { TaskDeps } from "../../../src/tasks/deps";
import { FAKE_PI, VALID_RESULT, assistant, installFakePi, installPassThroughBwrap, piEvents } from "../../support/fake-pi";
import { defaultRunVariables } from "../../../src/isolation/run-environment";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const registry = createTaskRegistry();

async function world() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-pi-agent-run-"));
  directories.push(root);
  const { command } = await installFakePi(path.join(root, "install"), FAKE_PI);
  const fakeBin = path.join(root, "fake-bin");
  await installPassThroughBwrap(fakeBin);
  const service = path.join(root, "service-pi");
  const workspace = path.join(root, "ws");
  await Promise.all([mkdir(service), mkdir(workspace)]);
  const store = await ConveyorStore.open(path.join(root, "db.sqlite"));
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "o/r", folder: "/f", configHash: "h" });
  store.upsertIssue({
    id: "i1", repositoryId: "repo", sourceNumber: 7, sourceUrl: "https://x/7", title: "Fix it", body: "Body",
    sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  const enrollment = store.activateEnrollment("i1");
  store.recordWorkspace({ id: "w1", enrollmentId: enrollment.id, path: workspace, branch: "conveyor/7", status: "active" });
  const instructions = path.join(root, "agent.md");
  await writeFile(instructions, "You review.");
  const capture = path.join(root, "capture.json");
  const events = path.join(root, "events.jsonl");
  const resumedEvents = path.join(root, "events-resumed.jsonl");
  const environment = { ...defaultRunVariables(), PATH: `${fakeBin}:${process.env.PATH}`, CAPTURE: capture, FAKE_EVENTS: events, FAKE_EVENTS_RESUMED: resumedEvents };
  const config = {
    hash: "cfg",
    settings: { artifacts: path.join(root, "artifacts"), interruptGraceMs: 100, agentRunTokenWarning: 15_000_000 },
    agents: {
      parisa: { runner: "pi", instructions, tasks: [], name: "Parisa", title: "Reviewer", workspaceAccess: "read-only", environment },
      shirin: { runner: "claude", instructions, tasks: [], name: "Shirin", title: "Reviewer", workspaceAccess: "read-only" },
    },
    runners: { pi: { type: "pi", command, configDir: service, credentialVariables: [], environment: { EXAMPLE_API_KEY: "provider-key" } }, claude: { type: "claude-code", command: "claude" } },
  } as unknown as ConveyorConfig;
  const claudeCalls: HarnessRunInput[] = [];
  const claude: Harness = {
    id: "claude-code", capabilities: { sessionResume: true }, profile: claudeCodeProfile,
    async run(input) {
      claudeCalls.push(input);
      return {
        stageResult: { outcome: "success", status: "done", summary: "Shirin reviewed", reason: null, metrics: {} },
        sessionId: "claude-1", usage: { ...EMPTY_USAGE }, cost: { ...UNAVAILABLE_COST }, durationMs: 1, exitCode: 0, artifacts: [], stderr: "",
      };
    },
  };
  const deps = {
    store, config, items: {} as never, git: {} as never,
    workspaces: { create: async () => { throw new Error("unused"); }, restore: async () => {}, ensureScratch: async (p: string) => { await mkdir(`${p}.tmp`, { recursive: true }); }, remove: async () => {} },
    repository: { id: "repo", address: "o/r", folder: "/f", baseBranch: "main" },
    issueId: "i1", sourceGuidance: "GUIDE", signal: new AbortController().signal,
    harnesses: { pi: piHarness, "claude-code": claude },
    delivery: async () => ({ pullRequest: null, checks: [] }),
    mcp: { create: async () => ({ configuration: { command: "bun", args: ["mcp"] }, close: () => {} }) },
  } as unknown as TaskDeps;
  const context = { run: { stage: "review", attempt: 1, feedback: null, taskInstanceId: "review" } } as unknown as Partial<TaskContext>;
  const run = (agentConfig: unknown) => runTask(registry.require("agent.run"), {
    context, deps, config: agentConfig, instance: { id: "review", stage: "review", idempotencyKey: "key-1", resumed: false },
  });
  const captured = async () => JSON.parse(await readFile(capture, "utf8")) as { args: string[]; stdin: string; resumed: string | null; env: Record<string, string> };
  return { store, run, events, resumedEvents, service, captured, claudeCalls };
}

const output = (result: TaskResult) => (result as Extract<TaskResult, { status: "pass" }>).output as Record<string, unknown>;

describe("agent.run with a pi runner", () => {
  test("an invalid result goes back to the same pi session once, which corrects it", async () => {
    const w = await world();
    await writeFile(w.events, piEvents("sess-1", [assistant("All done, the change looks good.")]));
    await writeFile(w.resumedEvents, piEvents("sess-1", [assistant(JSON.stringify({ ...VALID_RESULT, summary: "Reviewed" }))]));

    const result = await w.run({ agent: "parisa" });

    expect(result.status).toBe("pass");
    expect(output(result)).toMatchObject({ agentId: "parisa", status: "done", summary: "Reviewed", sessionId: "sess-1" });
    const corrected = await w.captured();
    expect(corrected.args[corrected.args.indexOf("--session") + 1]).toEndWith("_sess-1.jsonl");
    expect(corrected.stdin).toContain("Your result was rejected: pi's final message is not a JSON result");
    expect(corrected.resumed).toContain("You review.");
    // The run carries its runner, whose credential variables only the pi process receives.
    expect(corrected.env.EXAMPLE_API_KEY).toBe("provider-key");
    expect(w.claudeCalls).toHaveLength(0);
  });

  test("a pi agent at its usage limit hands the stage to the next listed agent, and says so", async () => {
    const w = await world();
    await writeFile(w.events, piEvents("sess-8", [assistant("", { stopReason: "error", errorMessage: "429 rate_limit_error: usage limit reached" })]));

    const result = await w.run({ agents: ["parisa", "shirin"] });

    expect(result.status).toBe("pass");
    expect(output(result)).toMatchObject({ agentId: "shirin", summary: "Shirin reviewed" });
    expect(w.claudeCalls).toHaveLength(1);
    const notes = w.store.listConversationMessages("i1", 100).filter((message) => message.actorName === "Conveyor").map((message) => message.message);
    expect(notes).toEqual([expect.stringMatching(/^Parisa could not run \(pi's model request failed: 429 rate_limit_error: usage limit reached\); Shirin takes this review instead\.$/)]);
  });
});
