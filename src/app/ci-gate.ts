/**
 * The CI gate: a source action that holds an issue until every check on its
 * pull request's current head has finished, and turns the verdict into a stage
 * result.
 *
 * Agents never touch GitHub. They cannot dispatch workflows, so label-triggered
 * workflows (on `pull_request: labeled`) are started here, by the engine, for
 * the exact head being gated. A pending gate throws `ExternalWaitError`; the
 * service releases every permit and polls again later, so a thirty-minute
 * emulator run costs no runner slot and no agent turn.
 */

export class ExternalWaitError extends Error {
  override readonly name = "ExternalWaitError";

  constructor(
    message: string,
    readonly retryAfterMs: number,
    /** Posted once to the shared conversation (e.g. "CI started", with links). */
    readonly announcement: string | null = null,
  ) {
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

export interface CiTrigger {
  /** PR label whose `labeled` event starts the workflow. */
  label: string;
  /** Workflow file name under .github/workflows at the gated head. */
  workflow: string;
  /** Check-run (job) name the workflow reports; a skipped run does not count as started. */
  check: string;
  /** Labels of triggers this one already covers when its workflow exists. */
  replaces: string[];
}

export interface CiGateOptions {
  triggers: CiTrigger[];
  ignoreChecks: string[];
  settleMs: number;
  pollMs: number;
  timeoutMs: number;
  retriggerAfterMs: number;
  logLines: number;
}

export interface CiCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
  /** True when the check run is a GitHub Actions job whose id is a job id. */
  actionsJob: boolean;
}

export interface CiGateGitHub {
  getPullRequestHead(address: string, pullRequestNumber: number): Promise<{ sha: string }>;
  listCheckRuns(address: string, sha: string): Promise<CiCheckRun[]>;
  workflowExists(address: string, workflow: string, ref: string): Promise<boolean>;
  retriggerLabel(address: string, pullRequestNumber: number, label: string): Promise<void>;
  rerunJob(address: string, jobId: number): Promise<void>;
  jobLog(address: string, jobId: number): Promise<string>;
}

/** Per-process memory of what the gate has already done for a head. */
export interface CiGateMemory {
  firstSeen: Map<string, number>;
  triggered: Map<string, number>;
  reruns: Set<string>;
  announced: Set<string>;
}

export function createCiGateMemory(): CiGateMemory {
  return { firstSeen: new Map(), triggered: new Map(), reruns: new Set(), announced: new Set() };
}

const PASSING = new Set(["success", "skipped", "neutral"]);
const RERUNNABLE = new Set(["cancelled", "stale"]);

function positiveNumber(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`pullRequest.awaitChecks: ${name} must be a positive number`);
  }
  return value;
}

function stringList(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`pullRequest.awaitChecks: ${name} must be a list of names`);
  }
  return value as string[];
}

export function parseCiGateOptions(input: Record<string, unknown> | undefined): CiGateOptions {
  const raw = input ?? {};
  const triggers = raw.triggers === undefined ? [] : raw.triggers;
  if (!Array.isArray(triggers)) throw new Error("pullRequest.awaitChecks: triggers must be a list");
  return {
    triggers: triggers.map((trigger, index) => {
      if (!trigger || typeof trigger !== "object") {
        throw new Error(`pullRequest.awaitChecks: triggers[${index}] must be an object`);
      }
      const { label, workflow, check, replaces } = trigger as Record<string, unknown>;
      if (
        typeof label !== "string" || label.length === 0 ||
        typeof workflow !== "string" || !/^[\w.-]+\.ya?ml$/.test(workflow) ||
        typeof check !== "string" || check.length === 0
      ) {
        throw new Error(`pullRequest.awaitChecks: triggers[${index}] needs a label, a workflow file name and a check name`);
      }
      return { label, workflow, check, replaces: stringList(replaces, `triggers[${index}].replaces`) };
    }),
    ignoreChecks: stringList(raw.ignoreChecks, "ignoreChecks"),
    settleMs: positiveNumber(raw.settleSeconds, 120, "settleSeconds") * 1_000,
    pollMs: positiveNumber(raw.pollSeconds, 60, "pollSeconds") * 1_000,
    timeoutMs: positiveNumber(raw.timeoutMinutes, 180, "timeoutMinutes") * 60_000,
    retriggerAfterMs: positiveNumber(raw.retriggerMinutes, 10, "retriggerMinutes") * 60_000,
    logLines: positiveNumber(raw.logLines, 60, "logLines"),
  };
}

function skipped(check: CiCheckRun): boolean {
  return check.status === "completed" && check.conclusion === "skipped";
}

/**
 * Keep the newest run per check name: a rerun supersedes the attempt it
 * replaced. A real run always beats a skipped one, because every `labeled`
 * event also produces skipped runs of the other label-gated workflows.
 */
function latestByName(checks: CiCheckRun[]): CiCheckRun[] {
  const latest = new Map<string, CiCheckRun>();
  for (const check of checks) {
    const current = latest.get(check.name);
    const better = !current ||
      (skipped(current) && !skipped(check)) ||
      (skipped(current) === skipped(check) && check.id > current.id);
    if (better) latest.set(check.name, check);
  }
  return [...latest.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The part of an Actions job log that explains a failure: timestamps and colour
 * codes stripped, the post-job cleanup cut off, and the window ending at the
 * last `##[error]` line (or the end, when there is none).
 */
export function focusLog(text: string, lines: number): string {
  const all = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, "").replace(/\u001b\[[0-9;]*m/g, ""))
    .filter((line) => line.trim().length > 0);
  const cleanup = all.findIndex((line) => /^Post job cleanup\.|^Cleaning up orphan processes/.test(line));
  const body = cleanup >= 0 ? all.slice(0, cleanup) : all;
  let end = body.length;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    if (body[index]!.startsWith("##[error]")) {
      end = index + 1;
      break;
    }
  }
  return body.slice(Math.max(0, end - lines), end).join("\n");
}

export interface CiGateInput {
  address: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  issueKey: string;
  options: CiGateOptions;
  github: CiGateGitHub;
  memory: CiGateMemory;
  now: number;
}

export async function evaluateCiGate(input: CiGateInput): Promise<SourceActionOutcome> {
  const { address, pullRequestNumber, options, github, memory, now } = input;
  const { sha } = await github.getPullRequestHead(address, pullRequestNumber);
  const short = sha.slice(0, 7);
  const key = `${input.issueKey}@${sha}`;
  const firstSeen = memory.firstSeen.get(key) ?? now;
  memory.firstSeen.set(key, firstSeen);
  const elapsed = now - firstSeen;

  const present: CiTrigger[] = [];
  for (const trigger of options.triggers) {
    if (await github.workflowExists(address, trigger.workflow, sha)) present.push(trigger);
  }
  const replaced = new Set(present.flatMap((trigger) => trigger.replaces));
  const triggers = present.filter((trigger) => !replaced.has(trigger.label));

  const ignored = new Set(options.ignoreChecks);
  const allChecks = latestByName(await github.listCheckRuns(address, sha));
  const byName = new Map(allChecks.map((check) => [check.name, check]));

  const awaitingStart: string[] = [];
  for (const trigger of triggers) {
    const existing = byName.get(trigger.check);
    if (existing && !skipped(existing)) continue;
    const triggerKey = `${key}:${trigger.label}`;
    const last = memory.triggered.get(triggerKey);
    if (last === undefined || now - last >= options.retriggerAfterMs) {
      await github.retriggerLabel(address, pullRequestNumber, trigger.label);
      memory.triggered.set(triggerKey, now);
    }
    awaitingStart.push(trigger.check);
  }
  const started = new Set(awaitingStart);
  const checks = allChecks.filter((check) => !ignored.has(check.name) && !started.has(check.name));
  const running: CiCheckRun[] = [];
  const failed: CiCheckRun[] = [];
  for (const check of checks) {
    if (check.status !== "completed") {
      running.push(check);
      continue;
    }
    const conclusion = check.conclusion ?? "unknown";
    if (PASSING.has(conclusion)) continue;
    const rerunKey = `${key}:${check.name}`;
    if (RERUNNABLE.has(conclusion) && check.actionsJob && !memory.reruns.has(rerunKey)) {
      // A cancelled job says nothing about the code; give it one more run.
      memory.reruns.add(rerunKey);
      await github.rerunJob(address, check.id);
      running.push(check);
      continue;
    }
    failed.push(check);
  }

  if (failed.length > 0) {
    const sections: string[] = [];
    for (const check of failed) {
      let log = "";
      if (check.actionsJob) {
        try {
          log = focusLog(await github.jobLog(address, check.id), options.logLines);
        } catch (error) {
          log = `(log unavailable: ${error instanceof Error ? error.message : String(error)})`;
        }
      }
      sections.push(
        `### ${check.name} — ${check.conclusion}\n${check.url ?? ""}${log ? `\n\n\`\`\`\n${log}\n\`\`\`` : ""}`,
      );
    }
    const names = failed.map((check) => `${check.name} (${check.conclusion})`).join(", ");
    return {
      outcome: "failure",
      status: "changes-requested",
      reason: `CI failed on ${input.pullRequestUrl} at ${short}: ${names}.`,
      requiredFixes: failed.map(
        (check) => `Make the "${check.name}" check pass on the pull request head (${check.url ?? "no URL"}); read its log with delivery.get_check_logs.`,
      ),
      summary: `CI failed at ${short}: ${names}.\n${input.pullRequestUrl}/checks\n\n${sections.join("\n\n")}`,
    };
  }

  const waitingOn = [
    ...awaitingStart.map((check) => `${check} to start`),
    ...running.map((check) => check.name),
  ];
  if (waitingOn.length > 0 || elapsed < options.settleMs) {
    if (elapsed >= options.timeoutMs) {
      return {
        outcome: "failure",
        status: "blocked",
        reason: `CI for ${short} did not finish within ${Math.round(options.timeoutMs / 60_000)} minutes; still waiting on ${waitingOn.join(", ") || "checks to register"}.`,
        summary: `CI timed out at ${short}.`,
      };
    }
    // Announce once per head, as soon as there is something to link to.
    let announcement: string | null = null;
    if (checks.length > 0 && !memory.announced.has(key)) {
      memory.announced.add(key);
      announcement = [
        `CI started for ${short}: ${input.pullRequestUrl}/checks`,
        ...checks.map((check) => `- ${check.name}: ${check.url ?? "no link"}`),
        ...awaitingStart.map((name) => `- ${name}: starting`),
      ].join("\n");
    }
    throw new ExternalWaitError(
      `Waiting for CI at ${short}: ${waitingOn.join(", ") || "checks to register"}.`,
      options.pollMs,
      announcement,
    );
  }

  return {
    outcome: "success",
    status: "done",
    reason: null,
    summary: checks.length > 0
      ? [
          `CI passed at ${short}: ${input.pullRequestUrl}/checks`,
          ...checks.map((check) => `- ${check.name} (${check.conclusion}): ${check.url ?? "no link"}`),
        ].join("\n")
      : `No CI checks reported for ${short}.`,
  };
}
