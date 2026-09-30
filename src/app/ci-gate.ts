/** Provider-neutral CI gate. A pending gate releases all runner permits. */
import type { CiChange, CiProvider, CiRun } from "./ci-provider";

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
  const running: CiRun[] = [];
  const failed: CiRun[] = [];
  for (const run of checks) {
    if (run.state === "queued" || run.state === "running") { running.push(run); continue; }
    if (run.state === "passed" || run.state === "skipped") continue;
    const rerunKey = `${key}:${run.name}`;
    if (run.state === "cancelled" && run.canRerun && !memory.reruns.has(rerunKey)) {
      memory.reruns.add(rerunKey);
      await provider.rerun(change, run.id);
      running.push(run);
    } else failed.push(run);
  }

  if (failed.length > 0) {
    const sections: string[] = [];
    for (const run of failed) {
      let log = "";
      if (run.hasLog) {
        try { log = await provider.log(change, run.id, options.logLines); }
        catch (error) { log = `(log unavailable: ${error instanceof Error ? error.message : String(error)})`; }
      }
      sections.push(`### ${run.name} — ${run.state}\n${run.url ?? ""}${log ? `\n\n\`\`\`\n${log}\n\`\`\`` : ""}`);
    }
    const names = failed.map((run) => `${run.name} (${run.state})`).join(", ");
    return {
      outcome: "failure", status: "changes-requested",
      reason: `CI failed on ${change.url} at ${short}: ${names}.`,
      requiredFixes: failed.map((run) => `Make the "${run.name}" check pass on the pull request head (${run.url ?? "no URL"}); read its log with delivery.get_check_logs.`),
      summary: `CI failed at ${short}: ${names}.\n${change.url}/checks\n\n${sections.join("\n\n")}`,
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
      announcement = [`CI started for ${short}: ${change.url}/checks`, ...checks.map((run) => `- ${run.name}: ${run.url ?? "no link"}`), ...awaitingStart.map((name) => `- ${name}: starting`)].join("\n");
    }
    throw new ExternalWaitError(`Waiting for CI at ${short}: ${waitingOn.join(", ") || "checks to register"}.`, options.pollMs, announcement);
  }
  return {
    outcome: "success", status: "done", reason: null,
    summary: checks.length > 0 ? [`CI passed at ${short}: ${change.url}/checks`, ...checks.map((run) => `- ${run.name} (${run.state}): ${run.url ?? "no link"}`)].join("\n") : `No CI checks reported for ${short}.`,
  };
}
