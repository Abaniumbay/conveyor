import type { CompiledPipeline, CompiledTask } from "./plan";

export function formatMs(ms: number): string {
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1_000]] as const) {
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}

export function renderOnFail(task: CompiledTask, list: "actions" | "exit-gate"): string {
  const route = task.onFail;
  if (!route && task.label) return "onFail decided by the task";
  if (!route) return list === "actions" ? "onFail stop blocked (default)" : "onFail retry (default)";
  if ("retry" in route) return "onFail retry";
  if ("return" in route) return `onFail return ${route.return}`;
  return `onFail stop ${route.stop}`;
}

function renderList(list: "actions" | "exit-gate", tasks: CompiledTask[]): string[] {
  const lines = [`  ${list}:`];
  if (tasks.length === 0) return [...lines, "    (none)"];
  for (const [index, task] of tasks.entries()) {
    for (const key of task.implicitLoads) lines.push(`    (load ${key})`);
    const name = task.id === task.task ? task.task : `${task.id}: ${task.task}`;
    lines.push(`    ${index + 1}. ${name}${task.label ? ` (${task.label})` : ""} [${task.kind}]`);
    if (!task.label && Object.keys(task.with).length > 0) lines.push(`       with ${JSON.stringify(task.with)}`);
    const timeout = task.wait.timeoutMs === null ? "unlimited" : formatMs(task.wait.timeoutMs);
    lines.push(`       wait timeout ${timeout}, poll ${formatMs(task.wait.pollMs)}; ${renderOnFail(task, list)}`);
  }
  return lines;
}

/** Human-readable expanded plan: implicit loads shown, guards already resolved. */
export function renderPlan(plan: CompiledPipeline): string {
  const lines = [`Repository ${plan.repositoryId} (pipeline ${plan.id})`];
  for (const stage of plan.stages) {
    const details = [`concurrency ${stage.concurrency}`, `retries ${stage.retries}`];
    if (stage.childrenStartAt) details.push(`childrenStartAt ${stage.childrenStartAt}`);
    if (stage.legacy) details.push("legacy");
    lines.push("", `Stage ${stage.id} (${details.join(", ")})`);
    lines.push(...renderList("actions", stage.actions), ...renderList("exit-gate", stage.exitGate));
  }
  return lines.join("\n");
}
