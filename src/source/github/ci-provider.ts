import { parse as parseYaml } from "yaml";
import { inflateRawSync } from "node:zlib";

import { FOCUSED_LOG_BREAK } from "../../app/ci-gate";
import type { CiChange, CiDefinition, CiProvider, CiRun, CiTestReport, CiTestReportLocator } from "../../app/ci-provider";
import type { GitHubActionsJob, GitHubAdapter, GitHubCheckRun } from "./adapter";

export interface GitHubActionsTrigger {
  label: string;
  workflow: string;
  check: string;
  replaces: string[];
}

export function parseGitHubActionsTriggers(value: unknown, path = "ci provider triggers"): GitHubActionsTrigger[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path} must be a list`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${path}[${index}] must be an object`);
    const trigger = item as Record<string, unknown>;
    if (typeof trigger.label !== "string" || !trigger.label || typeof trigger.workflow !== "string" || !/^[\w.-]+\.ya?ml$/.test(trigger.workflow) || typeof trigger.check !== "string" || !trigger.check) {
      throw new Error(`${path}[${index}] needs a label, workflow file name and check name`);
    }
    const replaces = trigger.replaces ?? [];
    if (!Array.isArray(replaces) || replaces.some((name) => typeof name !== "string" || !name)) throw new Error(`${path}[${index}].replaces must be a list of names`);
    return { label: trigger.label, workflow: trigger.workflow, check: trigger.check, replaces: replaces as string[] };
  });
}

function skipped(run: CiRun): boolean { return run.state === "skipped"; }

function neverStarted(job: GitHubActionsJob): boolean {
  return !job.runner_name
    && Array.isArray(job.steps)
    && !job.steps.some((step) => step.status === "completed" || step.status === "in_progress");
}

function neutralState(status: string, conclusion: string | null): CiRun["state"] {
  if (status !== "completed") return status === "queued" || status === "requested" ? "queued" : "running";
  if (conclusion === "success" || conclusion === "neutral") return "passed";
  if (conclusion === "skipped") return "skipped";
  if (conclusion === "cancelled" || conclusion === "stale") return "cancelled";
  return "failed";
}

function canRerun(status: string, conclusion: string | null): boolean {
  return status === "completed" && ["failure", "cancelled", "timed_out", "action_required", "stale"].includes(conclusion ?? "");
}

/** Lines that mark an individual failing test in common runners' output. */
const FAILURE_MARKERS = [
  /^not ok \d+/, // TAP (node --test, tap)
  /^(##\[group\])?\s*(✖|✗|❌|×)\s/, // node, mocha, flutter/dart reporters (GitHub groups failed tests)
  /^\(fail\)\s/, // Bun
  /EXCEPTION CAUGHT BY FLUTTER TEST FRAMEWORK/, // followed by the Expected/Actual of a Flutter test
  /^\s*FAIL\s/, // jest, vitest
  /^--- FAIL:/, // go test
  /AssertionError|Assertion failed/,
];
const FAILURE_CONTEXT_BEFORE = 1;
const FAILURE_CONTEXT_AFTER = 12;

/**
 * The part of a job log that explains a failure: every failing-test block found anywhere in the
 * log (a runner can report it hundreds of lines before the job's final error), followed by the
 * `lines` lines that end at the last `##[error]`. Cleanup output is dropped.
 */
export function focusGitHubActionsLog(text: string, lines: number): string {
  const all = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, "").replace(/\u001b\[[0-9;]*m/g, ""))
    .filter((line) => line.trim().length > 0);
  const cleanup = all.findIndex((line) => /^Post job cleanup\.|^Cleaning up orphan processes/.test(line));
  const body = cleanup >= 0 ? all.slice(0, cleanup) : all;
  let end = body.length;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    if (body[index]!.startsWith("##[error]")) { end = index + 1; break; }
  }
  const tailStart = Math.max(0, end - lines);
  const picked = new Set<number>();
  for (let index = 0; index < tailStart && picked.size < lines; index += 1) {
    if (!FAILURE_MARKERS.some((marker) => marker.test(body[index]!))) continue;
    const from = Math.max(0, index - FAILURE_CONTEXT_BEFORE);
    const to = Math.min(tailStart, index + FAILURE_CONTEXT_AFTER + 1);
    for (let line = from; line < to && picked.size < lines; line += 1) picked.add(line);
  }
  const failures = [...picked].sort((left, right) => left - right).map((index) => body[index]!);
  const tail = body.slice(tailStart, end);
  return failures.length > 0 ? [...failures, FOCUSED_LOG_BREAK, ...tail].join("\n") : tail.join("\n");
}

const CHANGE_EVENTS = ["pull_request", "pull_request_target", "push"];

function u16(bytes: Uint8Array, offset: number): number { return bytes[offset]! | (bytes[offset + 1]! << 8); }
function u32(bytes: Uint8Array, offset: number): number { return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0; }

/** Extracts matching regular ZIP entries. Actions artifacts are ZIP files. */
function zipEntries(bytes: Uint8Array, pattern: string): Array<{ path: string; content: string }> {
  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at -= 1) {
    if (u32(bytes, at) === 0x06054b50) { eocd = at; break; }
  }
  if (eocd < 0) throw new Error("artifact is not a ZIP archive");
  const glob = new Bun.Glob(pattern);
  const decoder = new TextDecoder();
  const entries: Array<{ path: string; content: string }> = [];
  let at = u32(bytes, eocd + 16);
  const end = at + u32(bytes, eocd + 12);
  while (at < end) {
    if (u32(bytes, at) !== 0x02014b50) throw new Error("artifact ZIP central directory is malformed");
    const compression = u16(bytes, at + 10);
    const compressed = u32(bytes, at + 20);
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    const local = u32(bytes, at + 42);
    const path = decoder.decode(bytes.slice(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (!glob.match(path)) continue;
    if (u32(bytes, local) !== 0x04034b50) throw new Error(`artifact entry ${path} is malformed`);
    const localName = u16(bytes, local + 26);
    const localExtra = u16(bytes, local + 28);
    const data = bytes.slice(local + 30 + localName + localExtra, local + 30 + localName + localExtra + compressed);
    const content = compression === 0 ? data : compression === 8 ? inflateRawSync(data) : (() => { throw new Error(`artifact entry ${path} uses unsupported ZIP compression`); })();
    entries.push({ path, content: decoder.decode(content) });
  }
  return entries;
}

/** The change-triggering events a workflow listens to (`on` as a string, list or map). Branch filters are ignored. */
function changeEvents(source: string): string[] {
  let on: unknown;
  try { on = (parseYaml(source) as { on?: unknown } | null)?.on; } catch { return []; }
  const events = typeof on === "string" ? [on]
    : Array.isArray(on) ? on.filter((event): event is string => typeof event === "string")
    : on && typeof on === "object" ? Object.keys(on) : [];
  return events.filter((event) => CHANGE_EVENTS.includes(event));
}

/** GitHub Actions adapter. GitHub vocabulary stays at this provider boundary. */
export class GitHubActionsCiProvider implements CiProvider {
  readonly #started = new Map<string, number>();
  readonly #definitions = new Map<string, CiDefinition>();

  constructor(
    private readonly github: GitHubAdapter,
    private readonly triggers: GitHubActionsTrigger[] = [],
  ) {}

  async start(change: CiChange, commit: string, retryWindowMs: number, now: number): Promise<string[]> {
    const present: GitHubActionsTrigger[] = [];
    for (const trigger of this.triggers) {
      if (await this.github.workflowExists(change.repository, trigger.workflow, commit)) present.push(trigger);
    }
    const replaced = new Set(present.flatMap((trigger) => trigger.replaces));
    const configured = present.filter((trigger) => !replaced.has(trigger.label));
    const runs = await this.list(change, commit);
    const waiting: string[] = [];
    for (const trigger of configured) {
      const existing = runs.find((run) => run.name === trigger.check);
      if (existing && existing.state !== "skipped") continue;
      const key = `${change.repository}#${change.changeId}@${commit}:${trigger.label}`;
      const last = this.#started.get(key);
      if (last === undefined || now - last >= retryWindowMs) {
        await this.github.retriggerLabel(change.repository, Number(change.changeId), trigger.label);
        this.#started.set(key, now);
      }
      waiting.push(trigger.check);
    }
    return waiting;
  }

  async list(change: CiChange, commit: string): Promise<CiRun[]> {
    const runs = await this.github.listCheckRuns(change.repository, commit);
    const latest = new Map<string, { raw: GitHubCheckRun; run: CiRun; skipped: boolean; order: number }>();
    for (const raw of runs) {
      const run: CiRun = {
        id: String(raw.id),
        name: raw.name,
        url: raw.details_url,
        state: neutralState(raw.status, raw.conclusion),
        canRerun: raw.app?.slug === "github-actions" && canRerun(raw.status, raw.conclusion),
        hasLog: raw.app?.slug === "github-actions",
        startedAt: raw.started_at ?? null,
        completedAt: raw.completed_at ?? null,
      };
      const order = raw.id;
      const current = latest.get(run.name);
      const isSkipped = skipped(run);
      if (!current || (current.skipped && !isSkipped) || (current.skipped === isSkipped && order > current.order)) {
        latest.set(run.name, { raw, run, skipped: isSkipped, order });
      }
    }
    const selected = await Promise.all([...latest.values()].map(async ({ raw, run }) => {
      if (run.state !== "failed" || raw.app?.slug !== "github-actions") return run;
      const job = await this.github.githubActionsJob(change.repository, raw.id);
      if (!neverStarted(job)) return run;
      const annotations = await this.github.checkRunAnnotations(change.repository, raw.id);
      const annotation = annotations
        .map((candidate) => candidate.message?.trim())
        .find((message): message is string => Boolean(message)) ?? null;
      return { ...run, neverStarted: { annotation } };
    }));
    return selected.sort((a, b) => a.name.localeCompare(b.name));
  }

  async rerun(change: CiChange, runId: string): Promise<void> {
    await this.github.rerunJob(change.repository, Number(runId));
  }

  async log(change: CiChange, runId: string, lines = 200): Promise<string> {
    return focusGitHubActionsLog(await this.github.jobLog(change.repository, Number(runId)), lines);
  }

  async reports(change: CiChange, commit: string, runs: readonly CiRun[], locator: CiTestReportLocator): Promise<CiTestReport[]> {
    const reports: CiTestReport[] = [];
    const workflowIds = new Set<number>();
    for (const run of runs.filter((candidate) => candidate.hasLog)) {
      const job = await this.github.githubActionsJob(change.repository, Number(run.id));
      if (job.run_id !== undefined) workflowIds.add(job.run_id);
    }
    const workflowRuns = await this.github.listWorkflowRuns(change.repository, commit);
    for (const run of workflowRuns.filter((candidate) => workflowIds.has(candidate.id) && candidate.status === "completed" && candidate.head_sha === commit)) {
      const artifacts = await this.github.listWorkflowArtifacts(change.repository, run.id);
      for (const artifact of artifacts.filter((candidate) => candidate.name === locator.artifact && !candidate.expired)) {
        const archive = await this.github.downloadWorkflowArtifact(change.repository, artifact.id);
        try {
          for (const report of zipEntries(archive, locator.path)) reports.push({ runId: String(run.id), artifactId: String(artifact.id), ...report });
        } catch (error) {
          reports.push({
            runId: String(run.id),
            artifactId: String(artifact.id),
            path: locator.path,
            content: "",
            error: `artifact ${artifact.name} is not a readable ZIP archive: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    }
    return reports;
  }

  /** Workflow files at the commit that run for a change, plus configured label triggers whose workflow exists. */
  async definitions(change: CiChange, commit: string): Promise<CiDefinition> {
    const key = `${change.repository}@${commit}`;
    const cached = this.#definitions.get(key);
    if (cached) return cached;
    let files: string[] | null;
    const applicable: string[] = [];
    try {
      files = await this.github.listWorkflowFiles(change.repository, commit);
      for (const file of (files ?? []).filter((name) => /\.ya?ml$/.test(name))) {
        const events = changeEvents(await this.github.workflowSource(change.repository, file, commit));
        if (events.length > 0) applicable.push(`${file} (${events.join(", ")})`);
      }
    } catch (error) {
      return { defined: false, provable: false, summary: `Could not read the workflows at ${commit.slice(0, 7)}: ${error instanceof Error ? error.message : String(error)}` };
    }
    const present = new Set(files ?? []);
    const triggers = this.triggers.filter((trigger) => present.has(trigger.workflow)).map((trigger) => `label ${trigger.label} -> ${trigger.workflow}`);
    const parts = [...applicable.map((entry) => `workflow ${entry}`), ...triggers.map((entry) => `trigger ${entry}`)];
    const result: CiDefinition = parts.length > 0
      ? { defined: true, provable: true, summary: parts.join("; ") }
      : { defined: false, provable: true, summary: files === null ? "No .github/workflows directory" : "No workflow runs for pull requests or pushes" };
    this.#definitions.set(key, result);
    return result;
  }
}
