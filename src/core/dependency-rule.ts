// The one rule for when a blocker counts as resolved, shared by the scheduler and item.dependenciesMet.
// Conveyor knows no stage by name: `after` is a stage of the blocker's own pipeline, taken from configuration.

/** What the rule reads of a blocker. */
export interface BlockerState {
  repositoryId: string;
  sourceState: string;
  projectedState: string | null;
  projectedStage: string | null;
}

/** The task whose `after` option sets the threshold. */
export const DEPENDENCIES_TASK = "item.dependenciesMet";

/** Whether `stage` is later than `after` in `stages` (a pipeline's stage ids, in order). A missing stage or an unknown `after` is never later. */
export function stagePassed(stage: string | null, stages: readonly string[] | null, after: string): boolean {
  const threshold = stages?.indexOf(after) ?? -1;
  return stage !== null && threshold >= 0 && stages!.indexOf(stage) > threshold;
}

/** A blocker is resolved when closed or done, or, with `after`, once it is past that stage of its own pipeline. */
export function dependencyResolved(
  blocker: BlockerState | null,
  after: string | undefined,
  stagesOf: (repositoryId: string) => readonly string[] | null,
): boolean {
  if (!blocker) return false;
  if (blocker.sourceState === "closed" || blocker.projectedState === "done") return true;
  return after !== undefined && stagePassed(blocker.projectedStage, stagesOf(blocker.repositoryId), after);
}
