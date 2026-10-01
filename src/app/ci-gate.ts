/** Provider-neutral CI gate. A pending gate releases all runner permits. */
import type { CiChange, CiProvider, CiRun, CiRunState } from "./ci-provider";

export class ExternalWaitError extends Error {
  override readonly name = "ExternalWaitError";
  constructor(message: string, readonly retryAfterMs: number, readonly announcement: string | null = null) {
    super(message);
  }
}

export interface SourceActionOutcome {
  outcome: "success" | "failure";
  status: string;
  summary: string;
  reason: string | null;
  requiredFixes?: string[];
}

export interface CiGateOptions {
  ignoreChecks: string[];
  settleMs: number;
  pollMs: number;
  timeoutMs: number;
  retriggerAfterMs: number;
  logLines: number;
}

export interface CiGateMemory {
  firstSeen: Map<string, number>;
  reruns: Set<string>;
  announced: Set<string>;
}

export function createCiGateMemory(): CiGateMemory {
  return { firstSeen: new Map(), reruns: new Set(), announced: new Set() };
}

function positiveNumber(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`ci.await: ${name} must be a positive number`);
  }
  return value;
}

function stringList(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`ci.await: ${name} must be a list of names`);
  }
  return value as string[];
}

export function parseCiGateOptions(input: Record<string, unknown> | undefined): CiGateOptions {
  const raw = input ?? {};
  return {
    ignoreChecks: stringList(raw.ignoreChecks, "ignoreChecks"),
    settleMs: positiveNumber(raw.settleSeconds, 120, "settleSeconds") * 1_000,
    pollMs: positiveNumber(raw.pollSeconds, 60, "pollSeconds") * 1_000,
    timeoutMs: positiveNumber(raw.timeoutMinutes, 180, "timeoutMinutes") * 60_000,
    retriggerAfterMs: positiveNumber(raw.retriggerMinutes, 10, "retriggerMinutes") * 60_000,
    logLines: positiveNumber(raw.logLines, 60, "logLines"),
  };
}

/**
 * Sorts a head's runs. A cancelled run that can be rerun (and has not been rerun for this head) is
 * `rerun`; every other cancelled or failed run is `failed`. Shared by the legacy gate and the `ci` tasks.
 */
export function classifyRuns<T extends { state: CiRunState }>(
  runs: T[],
  canRerunNow: (run: T) => boolean,
): { running: T[]; failed: T[]; rerun: T[] } {
  const running: T[] = [];
  const failed: T[] = [];
  const rerun: T[] = [];
  for (const run of runs) {
    if (run.state === "queued" || run.state === "running") running.push(run);
    else if (run.state === "passed" || run.state === "skipped") continue;
    else if (run.state === "cancelled" && canRerunNow(run)) rerun.push(run);
    else failed.push(run);
  }
  return { running, failed, rerun };
}

export interface FailedRun { name: string; state: CiRunState; url: string | null; log: string | null }

/** The failure message, required fixes and per-run log sections for failed runs. */
export function describeCiFailure(changeUrl: string, short: string, failed: FailedRun[]): {
  reason: string;
  names: string;
  requiredFixes: string[];
  sections: string[];
} {
  const names = failed.map((run) => `${run.name} (${run.state})`).join(", ");
  return {
    names,
    reason: `CI failed on ${changeUrl} at ${short}: ${names}.`,
    requiredFixes: failed.map((run) => `Make the "${run.name}" check pass on the pull request head (${run.url ?? "no URL"}); read its log with ci.getLogs.`),
    sections: failed.map((run) => `### ${run.name} — ${run.state}\n${run.url ?? ""}${run.log ? `\n\n\`\`\`\n${run.log}\n\`\`\`` : ""}`),
  };
}

/** The one conversation message that says CI started for a head. */
export function ciAnnouncement(changeUrl: string, short: string, runs: Array<{ name: string; url: string | null }>, awaitingStart: string[]): string {
  return [`CI started for ${short}: ${changeUrl}/checks`, ...runs.map((run) => `- ${run.name}: ${run.url ?? "no link"}`), ...awaitingStart.map((name) => `- ${name}: starting`)].join("\n");
}

/** A failed run's log, bounded; an unreadable log becomes a note instead of an error. */
export async function readRunLog(provider: CiProvider, change: CiChange, run: CiRun, lines: number): Promise<string | null> {
  if (!run.hasLog) return null;
  try { return await provider.log(change, run.id, lines); }
  catch (error) { return `(log unavailable: ${error instanceof Error ? error.message : String(error)})`; }
}

export interface CiGateInput {
  change: CiChange;
  headSha: string;
  issueKey: string;
  options: CiGateOptions;
  provider: CiProvider;
  memory: CiGateMemory;
  now: number;
}

export async function evaluateCiGate(input: CiGateInput): Promise<SourceActionOutcome> {
  const { change, options, provider, memory, now } = input;
  const sha = input.headSha;
  const short = sha.slice(0, 7);
  const key = `${input.issueKey}@${sha}`;
  const firstSeen = memory.firstSeen.get(key) ?? now;
  memory.firstSeen.set(key, firstSeen);
  const elapsed = now - firstSeen;

  const awaitingStart = await provider.start(change, sha, options.retriggerAfterMs, now);
  const ignored = new Set(options.ignoreChecks);
  const allRuns = await provider.list(change, sha);
  const checks = allRuns.filter((run) => !ignored.has(run.name) && !awaitingStart.includes(run.name));
  const { running, failed, rerun } = classifyRuns(checks, (run) => run.canRerun && !memory.reruns.has(`${key}:${run.name}`));
  for (const run of rerun) {
    memory.reruns.add(`${key}:${run.name}`);
    await provider.rerun(change, run.id);
    running.push(run);
  }

  if (failed.length > 0) {
    const logged: FailedRun[] = [];
    for (const run of failed) logged.push({ name: run.name, state: run.state, url: run.url, log: await readRunLog(provider, change, run, options.logLines) });
    const report = describeCiFailure(change.url, short, logged);
    return {
      outcome: "failure", status: "changes-requested",
      reason: report.reason,
      requiredFixes: report.requiredFixes,
      summary: `CI failed at ${short}: ${report.names}.\n${change.url}/checks\n\n${report.sections.join("\n\n")}`,
    };
  }

  const waitingOn = [...awaitingStart.map((name) => `${name} to start`), ...running.map((run) => run.name)];
  if (waitingOn.length > 0 || elapsed < options.settleMs) {
    if (elapsed >= options.timeoutMs) {
      return { outcome: "failure", status: "blocked", reason: `CI for ${short} did not finish within ${Math.round(options.timeoutMs / 60_000)} minutes; still waiting on ${waitingOn.join(", ") || "checks to register"}.`, summary: `CI timed out at ${short}.` };
    }
    let announcement: string | null = null;
    if (checks.length > 0 && !memory.announced.has(key)) {
      memory.announced.add(key);
      announcement = ciAnnouncement(change.url, short, checks, awaitingStart);
    }
    throw new ExternalWaitError(`Waiting for CI at ${short}: ${waitingOn.join(", ") || "checks to register"}.`, options.pollMs, announcement);
  }
  return {
    outcome: "success", status: "done", reason: null,
    summary: checks.length > 0 ? [`CI passed at ${short}: ${change.url}/checks`, ...checks.map((run) => `- ${run.name} (${run.state}): ${run.url ?? "no link"}`)].join("\n") : `No CI checks reported for ${short}.`,
  };
}
