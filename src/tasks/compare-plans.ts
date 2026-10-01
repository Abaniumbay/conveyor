import type { CompiledPipeline, CompiledStage, CompiledTask } from "./plan";
import { formatMs, renderOnFail } from "./render-plan";

type ListName = "actions" | "exit-gate";

export interface CompareLabels {
  left: string;
  right: string;
}

const lists = (stage: CompiledStage): [ListName, CompiledTask[]][] => [
  ["actions", stage.actions],
  ["exit-gate", stage.exitGate],
];

function cell(task: CompiledTask): string {
  const name = task.id === task.task ? task.task : `${task.id}: ${task.task}`;
  return task.label ? `${name} (${task.label})` : name;
}

/** The task name first, so a summary reads the same whatever the instance ids are. */
function summaryName(task: CompiledTask): string {
  const id = task.id === task.task ? "" : ` [${task.id}]`;
  return `${task.task}${id}${task.label ? ` (${task.label})` : ""}`;
}

function waitText(task: CompiledTask): string {
  const timeout = task.wait.timeoutMs === null ? "unlimited" : formatMs(task.wait.timeoutMs);
  return `wait timeout ${timeout}, poll ${formatMs(task.wait.pollMs)}`;
}

/** Everything about a task except its identity that a difference summary should surface. */
function behaviour(task: CompiledTask, list: ListName): string[] {
  return [waitText(task), renderOnFail(task, list), Object.keys(task.with).length > 0 ? `with ${JSON.stringify(task.with)}` : "with (none)"];
}

type Row = { left: CompiledTask | undefined; right: CompiledTask | undefined; matched: boolean };

/** Longest-common-subsequence alignment by task name; the gaps between matches are paired by position. */
function align(left: CompiledTask[], right: CompiledTask[]): Row[] {
  const lengths = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      lengths[i]![j] = left[i]!.task === right[j]!.task ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const rows: Row[] = [];
  let gapLeft: CompiledTask[] = [];
  let gapRight: CompiledTask[] = [];
  const flush = () => {
    for (let k = 0; k < Math.max(gapLeft.length, gapRight.length); k++) rows.push({ left: gapLeft[k], right: gapRight[k], matched: false });
    gapLeft = [];
    gapRight = [];
  };
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i]!.task === right[j]!.task) {
      flush();
      rows.push({ left: left[i++], right: right[j++], matched: true });
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) gapLeft.push(left[i++]!);
    else gapRight.push(right[j++]!);
  }
  gapLeft.push(...left.slice(i));
  gapRight.push(...right.slice(j));
  flush();
  return rows;
}

function sideBySide(rows: Row[], indent: string): string[] {
  const width = Math.max(0, ...rows.map((row) => (row.left ? cell(row.left).length : 1)));
  return rows.map((row) => `${indent}${(row.left ? cell(row.left) : "-").padEnd(width)} | ${row.right ? cell(row.right) : "-"}`);
}

function stageSummary(left: CompiledStage, right: CompiledStage): string[] {
  const out: string[] = [];
  const settings = (stage: CompiledStage) => ({
    concurrency: String(stage.concurrency),
    retries: String(stage.retries),
    childrenStartAt: stage.childrenStartAt ?? "none",
  });
  const before = settings(left);
  const after = settings(right);
  for (const key of Object.keys(before) as (keyof typeof before)[]) {
    if (before[key] !== after[key]) out.push(`changed: stage ${left.id} ${key} ${before[key]} -> ${after[key]}`);
  }
  return out;
}

function compareStage(left: CompiledStage | undefined, right: CompiledStage | undefined, labels: CompareLabels): { lines: string[]; summary: string[] } {
  const id = (left ?? right)!.id;
  const lines = [`  Stage ${id}${left && right ? "" : ` (only in ${left ? labels.left : labels.right})`}`];
  const summary: string[] = [];
  if (!left || !right) {
    summary.push(`${left ? "removed" : "added"}: stage ${id}`);
  } else {
    summary.push(...stageSummary(left, right));
  }
  for (const [name, leftTasks] of left ? lists(left) : lists({ ...right!, actions: [], exitGate: [] })) {
    const rightTasks = right ? lists(right).find(([other]) => other === name)![1] : [];
    const rows = align(leftTasks, rightTasks);
    lines.push(`    ${name}:`);
    if (rows.length === 0) lines.push("      (none) | (none)");
    else lines.push(...sideBySide(rows, "      "));
    if (!left || !right) continue;
    for (const row of rows) {
      if (!row.matched) {
        if (row.left) summary.push(`removed: ${name} ${summaryName(row.left)}`);
        if (row.right) summary.push(`added: ${name} ${summaryName(row.right)}`);
      } else if (row.left && row.right) {
        const before = behaviour(row.left, name);
        const after = behaviour(row.right, name);
        const changed = before.flatMap((part, index) => (part === after[index] ? [] : [`${part} -> ${after[index]}`]));
        if (changed.length > 0) summary.push(`changed: ${name} ${summaryName(row.right)}: ${changed.join("; ")}`);
      }
    }
  }
  return { lines, summary };
}

function comparePipeline(left: CompiledPipeline | undefined, right: CompiledPipeline | undefined, labels: CompareLabels): string[] {
  const repositoryId = (left ?? right)!.repositoryId;
  const only = left && right ? "" : ` (only in ${left ? labels.left : labels.right})`;
  const pipelines = left && right ? ` (pipeline ${left.id} -> ${right.id})` : ` (pipeline ${(left ?? right)!.id})`;
  const out = [`Repository ${repositoryId}${only || pipelines}`];
  const summary: string[] = [];
  const ids = [...new Set([...(left?.stages ?? []).map((stage) => stage.id), ...(right?.stages ?? []).map((stage) => stage.id)])];
  for (const id of ids) {
    const result = compareStage(left?.stages.find((stage) => stage.id === id), right?.stages.find((stage) => stage.id === id), labels);
    out.push("", ...result.lines);
    summary.push(...result.summary);
  }
  out.push("", `  Differences for ${repositoryId}:`);
  if (!left || !right) out.push(`    only in ${left ? labels.left : labels.right}`);
  else if (summary.length === 0) out.push("    no differences");
  else out.push(...summary.map((line) => `    ${line}`));
  return out;
}

/** Side-by-side task sequences per repository and stage, followed by a difference summary. */
export function comparePlans(left: CompiledPipeline[], right: CompiledPipeline[], labels: CompareLabels): string {
  const ids = [...new Set([...left.map((plan) => plan.repositoryId), ...right.map((plan) => plan.repositoryId)])];
  const header = [`Compare: ${labels.left} | ${labels.right}`];
  const blocks = ids.map((id) =>
    comparePipeline(left.find((plan) => plan.repositoryId === id), right.find((plan) => plan.repositoryId === id), labels).join("\n"),
  );
  return [...header, ...blocks].join("\n\n");
}
