export interface SchedulerCandidate {
  id: string;
  repositoryId: string;
  stageId: string;
  queueRank: number;
  siblingOrder: number | null;
  eligible: boolean;
  dependenciesSatisfied: boolean;
  rollupOnly?: boolean;
  /**
   * A stage that only runs an in-process source action (no producer or verifier
   * process). It needs no runner and must not queue behind long agent runs, so
   * it is bounded by its stage limit only.
   */
  lightweight?: boolean;
}

export interface ConcurrencyLimits {
  global: number;
  stages: Readonly<Record<string, number>>;
  repositories: Readonly<Record<string, number>>;
}

export interface ConcurrencyUsage {
  global: number;
  stages: Readonly<Record<string, number>>;
  repositories: Readonly<Record<string, number>>;
}

/** A currently active item, retained so status surfaces can explain a full permit. */
export interface SchedulerOccupant {
  id: string;
  repositoryId: string;
  stageId: string;
  lightweight: boolean;
}

export interface CapacityBlocker {
  scope: "global" | "stage" | "repository";
  used: number;
  limit: number;
  occupants: string[];
}

/**
 * Reports every applicable permit that is currently full for a candidate. This uses the same
 * lightweight accounting as selection: source-only work occupies a stage slot, but not a runner
 * or repository slot.
 */
export function capacityBlockers(
  candidate: Pick<SchedulerCandidate, "repositoryId" | "stageId" | "lightweight">,
  limits: ConcurrencyLimits,
  occupants: readonly SchedulerOccupant[],
): CapacityBlocker[] {
  const blocks: CapacityBlocker[] = [];
  const stageOccupants = occupants.filter((occupant) => occupant.stageId === candidate.stageId);
  const stageLimit = limits.stages[candidate.stageId] ?? 0;
  if (stageOccupants.length >= stageLimit) {
    blocks.push({ scope: "stage", used: stageOccupants.length, limit: stageLimit, occupants: stageOccupants.map((occupant) => occupant.id) });
  }
  if (candidate.lightweight) return blocks;

  const runnerOccupants = occupants.filter((occupant) => !occupant.lightweight);
  if (runnerOccupants.length >= limits.global) {
    blocks.unshift({ scope: "global", used: runnerOccupants.length, limit: limits.global, occupants: runnerOccupants.map((occupant) => occupant.id) });
  }
  const repositoryOccupants = runnerOccupants.filter((occupant) => occupant.repositoryId === candidate.repositoryId);
  const repositoryLimit = limits.repositories[candidate.repositoryId] ?? 0;
  if (repositoryOccupants.length >= repositoryLimit) {
    blocks.push({ scope: "repository", used: repositoryOccupants.length, limit: repositoryLimit, occupants: repositoryOccupants.map((occupant) => occupant.id) });
  }
  return blocks;
}

function compareCandidates(
  left: SchedulerCandidate,
  right: SchedulerCandidate,
): number {
  if (left.queueRank !== right.queueRank) return left.queueRank - right.queueRank;
  const leftSibling = left.siblingOrder ?? -1;
  const rightSibling = right.siblingOrder ?? -1;
  if (leftSibling !== rightSibling) return leftSibling - rightSibling;
  return left.id.localeCompare(right.id);
}

export function selectRunnableIssues(
  candidates: readonly SchedulerCandidate[],
  limits: ConcurrencyLimits,
  current: ConcurrencyUsage,
): SchedulerCandidate[] {
  const selected: SchedulerCandidate[] = [];
  let globalUsage = current.global;
  const stageUsage = { ...current.stages };
  const repositoryUsage = { ...current.repositories };

  for (const candidate of [...candidates].sort(compareCandidates)) {
    if (
      !candidate.eligible ||
      !candidate.dependenciesSatisfied ||
      candidate.rollupOnly
    ) {
      continue;
    }

    const stageLimit = limits.stages[candidate.stageId] ?? 0;
    const repositoryLimit = limits.repositories[candidate.repositoryId] ?? 0;
    const usedByStage = stageUsage[candidate.stageId] ?? 0;
    const usedByRepository = repositoryUsage[candidate.repositoryId] ?? 0;
    if (candidate.lightweight) {
      if (usedByStage >= stageLimit) continue;
      selected.push(candidate);
      stageUsage[candidate.stageId] = usedByStage + 1;
      continue;
    }
    if (
      globalUsage >= limits.global ||
      usedByStage >= stageLimit ||
      usedByRepository >= repositoryLimit
    ) {
      continue;
    }

    selected.push(candidate);
    globalUsage += 1;
    stageUsage[candidate.stageId] = usedByStage + 1;
    repositoryUsage[candidate.repositoryId] = usedByRepository + 1;
  }

  return selected;
}
