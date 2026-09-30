import { describe, expect, test } from "bun:test";

import {
  createCiGateMemory,
  evaluateCiGate,
  ExternalWaitError,
  focusLog,
  parseCiGateOptions,
  type CiCheckRun,
  type CiGateGitHub,
} from "../../src/app/ci-gate";

class FakeGitHub implements CiGateGitHub {
  sha = "abcdef1234567890";
  checks: CiCheckRun[] = [];
  workflows = new Set<string>();
  readonly labelled: string[] = [];
  readonly reruns: number[] = [];
  logs = "2026-01-01T00:00:00.0000000Z step one\n2026-01-01T00:00:01.0000000Z \u001b[31mError: boom\u001b[0m";

  async getPullRequestHead() {
    return { sha: this.sha };
  }
  async listCheckRuns() {
    return this.checks;
  }
  async workflowExists(_address: string, workflow: string) {
    return this.workflows.has(workflow);
  }
  async retriggerLabel(_address: string, _pr: number, label: string) {
    this.labelled.push(label);
  }
  async rerunJob(_address: string, jobId: number) {
    this.reruns.push(jobId);
  }
  async jobLog() {
    return this.logs;
  }
}

function check(id: number, name: string, status: string, conclusion: string | null): CiCheckRun {
  return { id, name, status, conclusion, url: `https://ci/${id}`, actionsJob: true };
}

const options = parseCiGateOptions({
  triggers: [
    { label: "run-web-e2e", workflow: "web-e2e.yml", check: "Headless Chrome smoke test" },
    { label: "run-android-e2e", workflow: "android-e2e.yml", check: "Android emulator smoke" },
    {
      label: "run-full-suite",
      workflow: "full-suite.yml",
      check: "Full suite",
      replaces: ["run-web-e2e", "run-android-e2e"],
    },
  ],
  settleSeconds: 60,
  pollSeconds: 30,
  timeoutMinutes: 60,
});

function gate(github: FakeGitHub, memory = createCiGateMemory(), now = 1_000_000) {
  return evaluateCiGate({
    address: "owner/repo",
    pullRequestNumber: 7,
    pullRequestUrl: "https://github.com/owner/repo/pull/7",
    issueKey: "issue-1",
    options,
    github,
    memory,
    now,
  });
}

describe("CI gate", () => {
  test("triggers label workflows present at the head and waits for them", async () => {
    const github = new FakeGitHub();
    github.workflows.add("web-e2e.yml");
    github.checks = [check(1, "Tests", "completed", "success")];

    const error = await gate(github).catch((caught) => caught);

    expect(error).toBeInstanceOf(ExternalWaitError);
    expect((error as ExternalWaitError).message).toContain("Headless Chrome smoke test to start");
    expect((error as ExternalWaitError).retryAfterMs).toBe(30_000);
    expect(github.labelled).toEqual(["run-web-e2e"]);
  });

  test("does not relabel on every poll, but does after the retrigger window", async () => {
    const github = new FakeGitHub();
    github.workflows.add("web-e2e.yml");
    const memory = createCiGateMemory();
    await gate(github, memory, 0).catch(() => undefined);
    await gate(github, memory, 60_000).catch(() => undefined);
    expect(github.labelled).toEqual(["run-web-e2e"]);
    await gate(github, memory, 11 * 60_000).catch(() => undefined);
    expect(github.labelled).toEqual(["run-web-e2e", "run-web-e2e"]);
  });

  test("a full-suite workflow replaces the per-platform triggers", async () => {
    const github = new FakeGitHub();
    github.workflows = new Set(["web-e2e.yml", "android-e2e.yml", "full-suite.yml"]);
    await gate(github).catch(() => undefined);
    expect(github.labelled).toEqual(["run-full-suite"]);
  });

  test("a skipped run from another label does not count as started or hide a real run", async () => {
    const github = new FakeGitHub();
    github.workflows.add("web-e2e.yml");
    github.checks = [check(5, "Headless Chrome smoke test", "completed", "skipped")];
    await gate(github).catch(() => undefined);
    expect(github.labelled).toEqual(["run-web-e2e"]);

    const passing = new FakeGitHub();
    passing.workflows.add("web-e2e.yml");
    passing.checks = [
      check(5, "Headless Chrome smoke test", "completed", "success"),
      check(9, "Headless Chrome smoke test", "completed", "skipped"),
    ];
    const memory = createCiGateMemory();
    memory.firstSeen.set(`issue-1@${passing.sha}`, 0);
    const outcome = await gate(passing, memory, 1_000_000);
    expect(outcome.outcome).toBe("success");
    expect(passing.labelled).toEqual([]);
  });

  test("waits while checks run and until the settle window passes", async () => {
    const github = new FakeGitHub();
    github.checks = [check(1, "Tests", "in_progress", null)];
    await expect(gate(github)).rejects.toThrow("Waiting for CI at abcdef1: Tests.");

    github.checks = [check(1, "Tests", "completed", "success")];
    const memory = createCiGateMemory();
    await expect(gate(github, memory, 0)).rejects.toThrow("checks to register");
    await expect(gate(github, memory, 61_000)).resolves.toMatchObject({ outcome: "success", status: "done" });
  });

  test("reruns a cancelled job once, then treats a second cancellation as a failure", async () => {
    const github = new FakeGitHub();
    github.checks = [check(4, "Tests", "completed", "cancelled")];
    const memory = createCiGateMemory();
    await expect(gate(github, memory)).rejects.toBeInstanceOf(ExternalWaitError);
    expect(github.reruns).toEqual([4]);

    github.checks = [check(8, "Tests", "completed", "cancelled")];
    const outcome = await gate(github, memory);
    expect(outcome).toMatchObject({ outcome: "failure", status: "changes-requested" });
    expect(github.reruns).toEqual([4]);
  });

  test("returns failing checks with cleaned log tails for the implementer", async () => {
    const github = new FakeGitHub();
    github.checks = [
      check(1, "Tests", "completed", "success"),
      check(2, "Android emulator smoke", "completed", "failure"),
      check(3, "Deploy", "in_progress", null),
    ];
    const outcome = await gate(github);
    expect(outcome.outcome).toBe("failure");
    expect(outcome.status).toBe("changes-requested");
    expect(outcome.reason).toBe(
      "CI failed on https://github.com/owner/repo/pull/7 at abcdef1: Android emulator smoke (failure).",
    );
    expect(outcome.summary).toContain("Error: boom");
    expect(outcome.summary).not.toContain("2026-01-01T");
    expect(outcome.summary).not.toContain("\u001b[");
    expect(outcome.requiredFixes?.[0]).toContain("delivery.get_check_logs");
  });

  test("ignores configured checks and stops as blocked after the timeout", async () => {
    const github = new FakeGitHub();
    github.checks = [check(1, "Deploy generator", "queued", null)];
    const ignoring = parseCiGateOptions({ ignoreChecks: ["Deploy generator"], settleSeconds: 1 });
    const memory = createCiGateMemory();
    memory.firstSeen.set(`issue-1@${github.sha}`, 0);
    await expect(evaluateCiGate({
      address: "owner/repo", pullRequestNumber: 7, pullRequestUrl: "u", issueKey: "issue-1",
      options: ignoring, github, memory, now: 10_000,
    })).resolves.toMatchObject({ outcome: "success", summary: "No CI checks reported for abcdef1." });

    const stuck = new FakeGitHub();
    stuck.checks = [check(1, "Tests", "queued", null)];
    const stuckMemory = createCiGateMemory();
    stuckMemory.firstSeen.set(`issue-1@${stuck.sha}`, 0);
    await expect(gate(stuck, stuckMemory, 61 * 60_000)).resolves.toMatchObject({
      outcome: "failure",
      status: "blocked",
    });
  });

  test("focuses a job log on the lines before the last error, without cleanup noise", () => {
    const log = [
      "\uFEFF2026-01-01T00:00:00.0000000Z ##[group]Run tests",
      "2026-01-01T00:00:01.0000000Z compiling",
      "2026-01-01T00:00:02.0000000Z \u001b[31mFAILED: launches the app\u001b[0m",
      "2026-01-01T00:00:03.0000000Z ##[error]Process completed with exit code 1.",
      "2026-01-01T00:00:04.0000000Z Post job cleanup.",
      "2026-01-01T00:00:05.0000000Z Terminate orphan process: pid (2705) (java)",
    ].join("\n");
    expect(focusLog(log, 2)).toBe("FAILED: launches the app\n##[error]Process completed with exit code 1.");
    expect(focusLog("a\nb\nc", 2)).toBe("b\nc");
  });

  test("rejects malformed options", () => {
    expect(() => parseCiGateOptions({ triggers: [{ label: "x", workflow: "../evil" , check: "c"}] })).toThrow();
    expect(() => parseCiGateOptions({ pollSeconds: 0 })).toThrow();
  });
});
