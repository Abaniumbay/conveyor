import type { StageCursor } from "../db/journal";

/** Synthetic cursor task for a stage-level approval that happens before actions. */
export const ENTRY_APPROVAL_TASK_ID = "entry-approval";

interface Entry {
  id: string;
  task: string;
}

/**
 * Whether finishing the stage from this cursor would start an agent or script process. A cursor
 * past every agent and script step leaves only checks, which start no process. A missing cursor
 * or an unknown cursor task is treated as starting one.
 */
export function remainingWorkStartsProcess(
  stage: { actions: readonly Entry[]; exitGate?: readonly Entry[] | undefined },
  cursor: Pick<StageCursor, "list" | "taskInstanceId"> | null,
): boolean {
  if (!cursor) return true;
  const exitGate = stage.exitGate ?? [];
  let remaining: readonly Entry[];
  if (cursor.list === "exit-gate") {
    remaining = exitGate;
  } else {
    const start = cursor.taskInstanceId === null || cursor.taskInstanceId === ENTRY_APPROVAL_TASK_ID
      ? 0
      : stage.actions.findIndex((entry) => entry.id === cursor.taskInstanceId);
    if (start < 0) return true;
    remaining = [...stage.actions.slice(start), ...exitGate];
  }
  return remaining.some((entry) => /^(agent|script)\.run$/.test(entry.task));
}
