// Pure helpers the stage executor uses to maintain the materialised task context.

import {
  SNAPSHOT_KEYS,
  type EngineState,
  type SnapshotKey,
  type TaskContext,
} from "../tasks/context";
import type { TaskDefinition } from "../tasks/contract";

export function engineState(context: TaskContext): EngineState {
  context.engine ??= { stale: [], returns: 0 };
  return context.engine;
}

export function markStale(context: TaskContext, keys: readonly SnapshotKey[]): void {
  const engine = engineState(context);
  for (const key of keys) if (!engine.stale.includes(key)) engine.stale.push(key);
}

export function snapshotReads(reads: readonly string[]): SnapshotKey[] {
  return SNAPSHOT_KEYS.filter((key) => reads.includes(key));
}

/** Snapshot keys to load before a task: the plan's implicit loads plus anything stale or never loaded. */
export function keysToLoad(context: TaskContext, task: { reads: string[]; implicitLoads: SnapshotKey[] }): SnapshotKey[] {
  const stale = engineState(context).stale;
  const needed = new Set<SnapshotKey>(task.implicitLoads);
  for (const key of snapshotReads(task.reads)) {
    if (stale.includes(key) || context[key] === undefined) needed.add(key);
  }
  return [...needed];
}

export function markLoaded(context: TaskContext, key: SnapshotKey): void {
  const engine = engineState(context);
  engine.stale = engine.stale.filter((stale) => stale !== key);
}

/** Captures an act's output into the engine-owned key it declares (`agent` replaced, `script` merged per instance). */
export function captureOutput(context: TaskContext, task: { id: string; writes: string[] }, output: unknown): void {
  if (output === undefined) return;
  if (task.writes.includes("agent")) context.agent = output as NonNullable<TaskContext["agent"]>;
  if (task.writes.includes("script")) {
    const results = { ...context.script?.results, [task.id]: output } as NonNullable<TaskContext["script"]>["results"];
    context.script = { results };
  }
}

export function recordCheckpoint(
  context: TaskContext,
  definition: TaskDefinition,
  taskInstanceId: string,
  at: string,
): void {
  const name = definition.checkpoint?.name;
  if (!name) return;
  const sha = name === "ciPassed" ? context.ci?.headSha : context.change?.headSha;
  if (sha) context.checkpoints[name] = { sha, at, taskInstanceId };
}

/** `pending.after` is not validated by the contract; anything but a finite, non-negative number is absent. */
export function validAfter(after: number | undefined): number | null {
  return typeof after === "number" && Number.isFinite(after) && after >= 0 ? after : null;
}

export function formatDuration(ms: number): string {
  if (ms > 0 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms > 0 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms > 0 && ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}
