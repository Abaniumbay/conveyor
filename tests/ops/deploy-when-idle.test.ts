import { describe, expect, test } from "bun:test";

import {
  parseDeployOptions,
  waitForStageExit,
  waitForStableIdle,
} from "../../scripts/deploy-when-idle";

describe("deploy-when-idle", () => {
  test("parses explicit deployment targets", () => {
    expect(parseDeployOptions([
      "--database", "/tmp/conveyor.sqlite",
      "--service", "conveyor.service",
      "--health-url", "http://127.0.0.1:7788/health/live",
      "--stable-checks", "2",
      "--poll-ms", "50",
      "--timeout-ms", "5000",
      "--after-issue", "github:AmirRaptoR/midgame#152",
      "--after-stage", "implementation",
    ])).toEqual({
      database: "/tmp/conveyor.sqlite",
      service: "conveyor.service",
      healthUrl: "http://127.0.0.1:7788/health/live",
      stableChecks: 2,
      pollMs: 50,
      timeoutMs: 5000,
      afterIssue: "github:AmirRaptoR/midgame#152",
      afterStage: "implementation",
    });
  });

  test("requires the issue and stage deployment boundary together", () => {
    expect(() => parseDeployOptions([
      "--database", "/tmp/conveyor.sqlite",
      "--service", "conveyor.service",
      "--health-url", "http://127.0.0.1:7788/health/live",
      "--after-issue", "github:AmirRaptoR/midgame#152",
    ])).toThrow("--after-issue and --after-stage must be used together");
  });

  test("requires consecutive idle checks and resets after activity", async () => {
    const samples = [
      { runs: 0, stages: 0 },
      { runs: 1, stages: 1 },
      { runs: 0, stages: 0 },
      { runs: 0, stages: 0 },
    ];
    let reads = 0;
    await waitForStableIdle(
      async () => samples[Math.min(reads++, samples.length - 1)]!,
      { stableChecks: 2, pollMs: 1, timeoutMs: 100 },
      async () => {},
    );
    expect(reads).toBe(4);
  });

  test("times out instead of deploying while work remains active", async () => {
    let now = 0;
    await expect(waitForStableIdle(
      async () => ({ runs: 1, stages: 1 }),
      { stableChecks: 2, pollMs: 10, timeoutMs: 25 },
      async () => { now += 10; },
      () => now,
    )).rejects.toThrow("timed out waiting for Conveyor to become idle");
  });

  test("waits for the selected issue to leave the selected stage", async () => {
    const samples = [
      { stageId: "implementation", status: "running" },
      { stageId: "implementation", status: "error" },
      { stageId: "implementation", status: "ready" },
      { stageId: "review", status: "awaiting-source" },
    ];
    let reads = 0;
    await waitForStageExit(
      async () => samples[Math.min(reads++, samples.length - 1)]!,
      "implementation",
      { pollMs: 1, timeoutMs: 100 },
      async () => {},
    );
    expect(reads).toBe(4);
  });

  test("times out if the selected issue never leaves its stage", async () => {
    let now = 0;
    await expect(waitForStageExit(
      async () => ({ stageId: "implementation", status: "ready" }),
      "implementation",
      { pollMs: 10, timeoutMs: 25 },
      async () => { now += 10; },
      () => now,
    )).rejects.toThrow("timed out waiting for implementation to finish");
  });
});
