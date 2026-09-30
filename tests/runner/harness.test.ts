import { describe, expect, test } from "bun:test";

import {
  AgentHarnessRegistry,
  HarnessError,
  type AgentHarness,
} from "../../src/runner/harness";
import { HarnessRetryExhaustedError, runWithHarnessRetries } from "../../src/runner/retry";
import { parseJsonLines, superviseProcess } from "../../src/runner/process";

const input = {
  workspace: "/work",
  artifactsDirectory: "/artifacts/run-1",
  prompt: "Perform the requested work.",
  instructions: "Follow the project guidance.",
  accessLevel: "workspace-write" as const,
  mcp: { command: "bun", args: ["run", "mcp.ts", "--context", "/tmp/context"] },
  model: "model-hint",
  effort: "high",
  timeoutMs: 1000,
  interruptGraceMs: 10,
  onEvent: (_event: unknown) => {},
};

function fakeHarness(): AgentHarness {
  return {
    async runProducer(input) {
      input.onEvent?.({ kind: "fake-progress" });
      return {
        stageResult: { outcome: "success", status: "done", summary: "Produced", reason: null, metrics: {} },
        sessionId: "producer-session",
        usage: { inputTokens: 4, outputTokens: 2, cachedTokens: 1 },
        cost: { amount: 0, currency: "USD", source: "unavailable" },
        durationMs: 12,
        exitCode: 0,
        artifacts: [],
        stderr: "",
      };
    },
    async runCheck() {
      return {
        decision: "pass",
        status: "done",
        reason: null,
        evidence: [],
        requiredFixes: [],
        criteria: [],
        sessionId: "check-session",
        usage: { inputTokens: 3, outputTokens: 1, cachedTokens: 0 },
        cost: { amount: 0, currency: "USD", source: "unavailable" },
        durationMs: 9,
        exitCode: 0,
        stderr: "",
      };
    },
    async runSteering() {
      return {
        summary: "Steering complete",
        sessionId: "steering-session",
        usage: { inputTokens: 2, outputTokens: 1, cachedTokens: 0 },
        cost: { amount: 0, currency: "USD", source: "unavailable" },
        durationMs: 7,
        exitCode: 0,
      };
    },
  };
}

describe("agent harness contract", () => {
  test("registers and runs producer, verifier, and steering methods with neutral inputs", async () => {
    const registry = new AgentHarnessRegistry().register("fake", () => fakeHarness());
    const harness = registry.create({ type: "fake" });
    const events: unknown[] = [];

    const producer = await harness.runProducer({ ...input, onEvent: (event) => events.push(event) });
    const check = await harness.runCheck({ ...input, phase: "exit", accessLevel: "read-only" });
    const steering = await harness.runSteering(input);

    expect(producer).toMatchObject({ sessionId: "producer-session", usage: { inputTokens: 4 }, exitCode: 0 });
    expect(check).toMatchObject({ sessionId: "check-session", decision: "pass", exitCode: 0 });
    expect(steering).toMatchObject({ sessionId: "steering-session", summary: "Steering complete" });
    expect(events).toEqual([{ kind: "fake-progress" }]);
    expect(() => registry.create({ type: "missing" })).toThrow('no agent harness registered for runner type "missing"');
  });

  test("retries usage limits with the configured bounded policy and stops interrupted runs", async () => {
    let calls = 0;
    const result = await runWithHarnessRetries(async () => {
      calls += 1;
      if (calls === 1) throw new HarnessError("rate limited", "usage-limit");
      return "ok";
    }, {
      infrastructureAttempts: 2,
      usageLimitAttempts: 2,
      minBackoff: 0,
      maxBackoff: 0,
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);

    calls = 0;
    await expect(runWithHarnessRetries(async () => {
      calls += 1;
      throw new HarnessError("cancelled", "interrupted");
    }, {
      infrastructureAttempts: 3,
      usageLimitAttempts: 3,
      minBackoff: 0,
      maxBackoff: 0,
    })).rejects.toMatchObject({ kind: "interrupted" });
    expect(calls).toBe(1);

    calls = 0;
    await expect(runWithHarnessRetries(async () => {
      calls += 1;
      throw new HarnessError("temporary failure", "process");
    }, {
      infrastructureAttempts: 2,
      usageLimitAttempts: 2,
      minBackoff: 0,
      maxBackoff: 0,
    })).rejects.toBeInstanceOf(HarnessRetryExhaustedError);
    expect(calls).toBe(2);
  });

  test("shares process capture, spawn errors, pre-abort, and JSONL protocol parsing", async () => {
    const result = await superviseProcess({
      command: [process.execPath, "-e", 'let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => { console.log(s); console.error("diagnostic"); });'],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      stdin: "prompt",
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "prompt\n", stderr: "diagnostic\n" });

    await expect(superviseProcess({
      command: ["conveyor-command-that-does-not-exist"],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      stdin: "",
    })).rejects.toMatchObject({ kind: "process" });

    const controller = new AbortController();
    controller.abort();
    await expect(superviseProcess({
      command: [process.execPath, "-e", "process.exit(0)"],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      stdin: "",
      signal: controller.signal,
    })).rejects.toMatchObject({ kind: "interrupted" });

    let streamed = false;
    await expect(superviseProcess({
      command: [process.execPath, "-e", 'process.stdout.write("ready\\n"); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
      stdin: "",
      timeoutMs: 250,
      interruptGraceMs: 10,
      onStdoutChunk: (chunk) => { if (chunk.includes("ready")) streamed = true; },
    })).rejects.toMatchObject({ kind: "timeout" });
    expect(streamed).toBe(true);

    expect(parseJsonLines('{"type":"event"}\nnot-json\n')).toEqual({
      events: [{ type: "event" }],
      invalidLine: "not-json",
    });
  });
});
