export interface SchedulerCandidate {
  id: string;
  repositoryId: string;
  stageId: string;
  queueRank: number;
  siblingOrder: number | null;
  eligible: boolean;
  dependenciesSatisfied: boolean;
  rollupOnly?: boolean;
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
