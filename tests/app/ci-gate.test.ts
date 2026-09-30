import { describe, expect, test } from "bun:test";
import type { CiChange, CiProvider, CiRun } from "../../src/app/ci-provider";
import { createCiGateMemory, evaluateCiGate, ExternalWaitError, parseCiGateOptions } from "../../src/app/ci-gate";
import { focusGitHubActionsLog } from "../../src/source/github/ci-provider";

class FakeProvider implements CiProvider {
  sha = "abcdef1234567890";
  runs: CiRun[] = [];
  waiting: string[] = [];
  readonly reruns: string[] = [];
  readonly started: Array<{ commit: string; retryWindowMs: number }> = [];
  logs = "2026-01-01T00:00:00.0000000Z step one\n2026-01-01T00:00:01.0000000Z ##[error]boom";
  async start(_change: CiChange, commit: string, retryWindowMs: number) { this.started.push({ commit, retryWindowMs }); return this.waiting; }
  async list() { return this.runs; }
  async rerun(_change: CiChange, runId: string) { this.reruns.push(runId); }
  async log() { return this.logs; }
}

const options = parseCiGateOptions({ settleSeconds: 60, pollSeconds: 30, timeoutMinutes: 60 });
const change = { repository: "owner/repo", changeId: "7", url: "https://github.com/owner/repo/pull/7" };
function run(id: string, name: string, state: CiRun["state"], extra: Partial<CiRun> = {}): CiRun {
  return { id, name, state, url: `https://ci/${id}`, canRerun: false, hasLog: true, ...extra };
}
function gate(provider: FakeProvider, memory = createCiGateMemory(), now = 1_000_000) {
  return evaluateCiGate({ change, headSha: provider.sha, issueKey: "issue-1", options, provider, memory, now });
}

describe("provider-neutral CI gate", () => {
  test("starts configured CI for the current commit and waits for it", async () => {
    const provider = new FakeProvider(); provider.waiting = ["Browser tests"];
    const error = await gate(provider).catch((caught) => caught);
    expect(error).toBeInstanceOf(ExternalWaitError);
    expect((error as ExternalWaitError).message).toContain("Browser tests to start");
    expect(provider.started).toEqual([{ commit: provider.sha, retryWindowMs: options.retriggerAfterMs }]);
  });
  test("waits for pending runs and settle window, then passes", async () => {
    const provider = new FakeProvider(); provider.runs = [run("1", "Tests", "running")];
    await expect(gate(provider)).rejects.toThrow("Waiting for CI");
    provider.runs = [run("2", "Tests", "passed")];
    const memory = createCiGateMemory(); memory.firstSeen.set(`issue-1@${provider.sha}`, 0);
    expect(await gate(provider, memory, 1_000_000)).toMatchObject({ outcome: "success", status: "done" });
  });
  test("returns focused failure logs", async () => {
    const provider = new FakeProvider(); provider.runs = [run("1", "Tests", "failed")];
    const outcome = await gate(provider);
    expect(outcome.status).toBe("changes-requested");
    expect(outcome.summary).toContain("##[error]boom");
    expect(outcome.requiredFixes?.[0]).toContain("delivery.get_check_logs");
  });
  test("reruns a cancelled capable run once, and times out pending CI", async () => {
    const provider = new FakeProvider(); provider.runs = [run("1", "Tests", "cancelled", { canRerun: true })];
    const memory = createCiGateMemory();
    await expect(gate(provider, memory)).rejects.toThrow(ExternalWaitError);
    expect((await gate(provider, memory)).status).toBe("changes-requested");
    expect(provider.reruns).toEqual(["1"]);
    memory.firstSeen.set(`issue-1@${provider.sha}`, 0);
    const pending = new FakeProvider(); pending.runs = [run("2", "Pending", "running")];
    const timedOut = await gate(pending, memory, options.timeoutMs + 1);
    expect(timedOut).toMatchObject({ outcome: "failure", status: "blocked" });
  });
  test("a new commit gets its own settle clock and focused logs trim cleanup", async () => {
    const provider = new FakeProvider(); provider.sha = "fedcba987"; provider.runs = [run("1", "Tests", "passed")];
    await expect(gate(provider)).rejects.toThrow(ExternalWaitError);
    expect(focusGitHubActionsLog("before\n##[error]bad\nPost job cleanup.\nafter", 5)).toBe("before\n##[error]bad");
  });
});
