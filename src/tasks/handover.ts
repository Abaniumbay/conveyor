// The handover: the item's current state, assembled by Conveyor at the start of every agent.run
// invocation and put in the prompt, so a run never depends on fetching it through tools first.
// Every part is bounded; a shortened part says what was left out and which tool returns it all.

import type { CiChange, CiRun } from "../app/ci-provider";
import { ReviewFindings } from "../engine/review-findings";
import { ItemTodos, summarizeTodos } from "../engine/todos";
import { inspectWorktree } from "../workspace/git";
import { importNativeReview } from "./change-findings";
import { agentActor, concise } from "./agent-support";
import type { TaskDeps } from "./deps";

export const HANDOVER_LIMITS = { todos: 40, findings: 20, findingText: 600, checks: 30, summary: 1_500 } as const;

interface Truncation { omitted: string; fullState: string }

function bounded<T>(items: readonly T[], limit: number, noun: string, fullState: string): { shown: T[]; truncated: Truncation | null } {
  if (items.length <= limit) return { shown: [...items], truncated: null };
  return { shown: items.slice(0, limit), truncated: { omitted: `${items.length - limit} more ${noun} (showing the first ${limit})`, fullState } };
}

/** Shortens text to a limit; the truncation is reported through `cut`. */
function clip(text: string, limit: number, cut: string[]): string {
  if (text.length <= limit) return text;
  cut.push(`text longer than ${limit} characters`);
  return `${text.slice(0, limit - 1)}…`;
}

function todosPart(deps: TaskDeps) {
  const items = new ItemTodos(deps.store.sqlite()).get(deps.issueId)?.items ?? [];
  if (items.length === 0) return { present: false, note: "This item has no todo list yet.", items: [], progress: null, truncated: null };
  const { shown, truncated } = bounded(items, HANDOVER_LIMITS.todos, "todos", "todo.get");
  return {
    present: true,
    progress: summarizeTodos(items) ? `${items.filter((i) => i.status === "done").length}/${items.length} done` : null,
    items: shown.map((item) => ({ id: item.id, text: item.text, status: item.status, ...(item.note ? { note: item.note } : {}) })),
    truncated,
  };
}

async function findingsPart(deps: TaskDeps) {
  // Same refresh as change.listFindings: threads resolved or added on the host since the last load.
  const stored = deps.store.getCurrentPullRequest(deps.issueId);
  if (stored && deps.codeHost) {
    try {
      const { change } = await deps.codeHost.getChangeDelivery({ address: deps.repository.address, id: stored.id });
      await importNativeReview(deps, stored.id, change.headSha);
    } catch { /* the stored findings are shown; change.listFindings refreshes them */ }
  }
  const open = new ReviewFindings(deps.store.sqlite()).list(deps.issueId).filter((finding) => finding.state === "open");
  if (open.length === 0) return { count: 0, note: "There are no open review findings.", items: [], truncated: null };
  const { shown, truncated } = bounded(open, HANDOVER_LIMITS.findings, "open findings", "change.listFindings");
  const cut: string[] = [];
  const items = shown.map((finding) => ({
    id: finding.id, author: finding.author,
    ...(finding.path ? { file: finding.path, ...(finding.line !== null ? { line: finding.line } : {}) } : {}),
    text: clip(finding.body, HANDOVER_LIMITS.findingText, cut),
  }));
  return {
    count: open.length, items,
    truncated: truncated ?? (cut.length > 0 ? { omitted: `finding text beyond ${HANDOVER_LIMITS.findingText} characters`, fullState: "change.listFindings" } : null),
  };
}

async function changePart(deps: TaskDeps) {
  const stored = deps.store.getCurrentPullRequest(deps.issueId);
  if (!stored) return { exists: false, note: "No change request exists yet." };
  if (!deps.codeHost) return { exists: true, available: false, note: "The change request cannot be read: no code host is configured. Use change.get." };
  try {
    const { change } = await deps.codeHost.getChangeDelivery({ address: deps.repository.address, id: stored.id });
    return {
      exists: true, number: change.number, url: change.url, headSha: change.headSha,
      mergeable: change.mergeable === null ? "unknown" : change.mergeable ? "yes" : "no",
      ci: await ciPart(deps, { repository: deps.repository.address, changeId: String(change.number), url: change.url }, change.headSha),
    };
  } catch (error) {
    return { exists: true, available: false, note: `The change request could not be read (${concise(error instanceof Error ? error.message : error, 200)}). Use change.get.` };
  }
}

async function ciPart(deps: TaskDeps, target: CiChange, headSha: string) {
  if (!deps.ci) return { available: false, note: "CI results are not available: no CI provider is configured. Use change.get." };
  try {
    // The provider lists runs of exactly this head; a later run of a check replaces an earlier one.
    const latest = new Map<string, CiRun>();
    const ignored = new Set(deps.config.repositories[deps.repository.id]?.ci.ignoreChecks ?? []);
    for (const run of await deps.ci.provider().list(target, headSha)) if (!ignored.has(run.name)) latest.set(run.name, run);
    if (latest.size === 0) return { available: true, headSha, checks: [], note: "No CI results are known for this head yet.", truncated: null };
    const { shown, truncated } = bounded([...latest.values()], HANDOVER_LIMITS.checks, "checks", "change.get");
    return { available: true, headSha, checks: shown.map((run) => ({ name: run.name, state: run.state, ...(run.url ? { url: run.url } : {}) })), truncated };
  } catch (error) {
    return { available: false, note: `CI results could not be read (${concise(error instanceof Error ? error.message : error, 200)}). Use change.get or ci.getLogs.` };
  }
}

const DISCARD_WARNING = (kind: string, commit: string | null) =>
  `A ${kind} is in progress in this worktree${commit ? ` and stopped on commit ${commit}` : ""}. Inspect it with git status, then finish it or redo it. Its work is intended work: do not discard it (no reset --hard, ${kind} --skip or --abort) without first understanding and preserving what it carries.`;

async function worktreePart(deps: TaskDeps, workspace: { path: string; branch: string }) {
  const unavailable = "unavailable";
  const state = await inspectWorktree(workspace.path, deps.repository.baseBranch).catch(() => null);
  const base = `origin/${deps.repository.baseBranch}`;
  return {
    assignedBranch: workspace.branch,
    branch: state?.branch ?? unavailable,
    headSha: state?.headSha ?? unavailable,
    clean: state?.clean ?? unavailable,
    gitOperation: state?.operation
      ? { kind: state.operation.kind, stoppedOn: state.operation.commit ?? unavailable, warning: DISCARD_WARNING(state.operation.kind, state.operation.commit) }
      : state?.operation === null ? "none" : unavailable,
    againstFetchedBase: state?.aheadBehind ? { base, ...state.aheadBehind } : { base, ahead: unavailable, behind: unavailable },
    fullState: "workspace.get and git status",
  };
}

function previousRunPart(deps: TaskDeps, stageId: string, currentRunId: string, agentId: string, kind: string) {
  const previous = deps.store.listRunsForStage(deps.issueId, stageId, kind).find((run) => run.id !== currentRunId);
  if (!previous) return { present: false, note: `No earlier run exists on the ${stageId} stage.` };
  const event = deps.store.listRunEvents(previous.id).find((entry) => entry.type === "execution");
  const id = (event?.payload as { agentId?: unknown } | undefined)?.agentId;
  const previousId = typeof id === "string" ? id : null;
  const result = (previous.result ?? {}) as { outcome?: unknown; status?: unknown; summary?: unknown };
  const cut: string[] = [];
  const name = previousId ? agentActor(deps.config, previousId).name : null;
  const different = previousId !== null && previousId !== agentId;
  return {
    present: true, runId: previous.id, agent: name ?? "unknown", runStatus: previous.status,
    outcome: typeof result.outcome === "string" ? result.outcome : "unavailable",
    status: typeof result.status === "string" ? result.status : "unavailable",
    summary: typeof result.summary === "string" ? clip(result.summary, HANDOVER_LIMITS.summary, cut) : "unavailable",
    ...(different ? { handoff: `The previous run on this stage was by ${name}, not by you (${agentActor(deps.config, agentId).name}). You continue ${name}'s work: it has no session here, so rely on this handover and the repository.` } : {}),
    truncated: cut.length > 0 ? { omitted: `summary text beyond ${HANDOVER_LIMITS.summary} characters`, fullState: "conversation.get" } : null,
  };
}

/** The handover for one run: the same shape for every harness and agent. */
export async function buildHandover(
  deps: TaskDeps,
  input: { runId: string; stageId: string; agentId: string; kind: string; workspace: { path: string; branch: string } },
) {
  return {
    note: "Current state of this item, assembled by Conveyor when this run started. Refresh it during the run with todo.get, change.listFindings, change.get and workspace.get; a part marked truncated names the tool that returns the rest.",
    todos: todosPart(deps),
    openFindings: await findingsPart(deps),
    change: await changePart(deps),
    worktree: await worktreePart(deps, input.workspace),
    previousRun: previousRunPart(deps, input.stageId, input.runId, input.agentId, input.kind),
  };
}
