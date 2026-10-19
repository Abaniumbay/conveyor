import type { ConveyorStore, StoredIssue } from "../db/store";

export interface InFlightInterval {
  limit: number;
  fromIndex: number;
  mergeIndex: number;
}

/** Returns the configured, inclusive code-stage interval when it is usable for a pipeline. */
export function inFlightInterval(
  stages: readonly { id: string }[],
  setting: { limit: number; from: string } | undefined,
  mergeIndex: number,
): InFlightInterval | null {
  if (!setting) return null;
  const fromIndex = stages.findIndex((stage) => stage.id === setting.from);
  if (fromIndex < 0 || mergeIndex < fromIndex) return null;
  return { limit: setting.limit, fromIndex, mergeIndex };
}

/**
 * Lists the enrolled leaf items that durably hold a repository code-pipeline slot.
 * A pending source transition already owns its destination so a crash cannot over-admit work.
 */
export function inFlightHolders(input: {
  store: ConveyorStore;
  repositoryId: string;
  stages: readonly { id: string }[];
  interval: InFlightInterval;
}): StoredIssue[] {
  const stageIndices = new Map(input.stages.map((stage, index) => [stage.id, index]));
  const pendingTargets = new Map(
    input.store.listPendingStageTransitions().map((transition) => [transition.issueId, transition.toStage]),
  );
  const terminalStates = new Set(["done", "offboarded", "paused", "rejected"]);
  return input.store.listIssues(input.repositoryId).filter((issue) => {
    if (issue.sourceState === "closed" || input.store.getActiveEnrollment(issue.id) === null) return false;
    if (input.store.listChildren(issue.id).length > 0) return false;
    const stageState = input.store.getStageState(issue.id);
    if (
      terminalStates.has(stageState?.status ?? "") ||
      terminalStates.has(issue.projectedState ?? "")
    ) {
      return false;
    }
    const stageId = pendingTargets.get(issue.id) ?? stageState?.stageId ?? issue.projectedStage;
    const index = stageId ? stageIndices.get(stageId) : undefined;
    return index !== undefined && index >= input.interval.fromIndex && index <= input.interval.mergeIndex;
  });
}
