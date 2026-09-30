import type { CiChange, CiProvider, CiRun } from "../../app/ci-provider";
import type { GitHubAdapter } from "./adapter";

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
  return body.slice(Math.max(0, end - lines), end).join("\n");
}

/** GitHub Actions adapter. GitHub vocabulary stays at this provider boundary. */
export class GitHubActionsCiProvider implements CiProvider {
  readonly #started = new Map<string, number>();

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
    const latest = new Map<string, { run: CiRun; skipped: boolean; order: number }>();
    for (const raw of runs) {
      const run: CiRun = {
        id: String(raw.id),
        name: raw.name,
        url: raw.details_url,
        state: neutralState(raw.status, raw.conclusion),
        canRerun: raw.app?.slug === "github-actions" && canRerun(raw.status, raw.conclusion),
        hasLog: raw.app?.slug === "github-actions",
      };
      const order = raw.id;
      const current = latest.get(run.name);
      const isSkipped = skipped(run);
      if (!current || (current.skipped && !isSkipped) || (current.skipped === isSkipped && order > current.order)) {
        latest.set(run.name, { run, skipped: isSkipped, order });
      }
    }
    return [...latest.values()].map(({ run }) => run).sort((a, b) => a.name.localeCompare(b.name));
  }

  async rerun(change: CiChange, runId: string): Promise<void> {
    await this.github.rerunJob(change.repository, Number(runId));
  }

  async log(change: CiChange, runId: string, lines = 200): Promise<string> {
    return focusGitHubActionsLog(await this.github.jobLog(change.repository, Number(runId)), lines);
  }
}
