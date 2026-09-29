import type { LabelConfiguration } from "./issue-state";
import { evaluateIssueState } from "./issue-state";
import type { ConveyorStore, RepositoryRecord } from "../db/store";
import type { IssueSourceAdapter } from "../source/types";

export interface ReconcileRepositoryInput {
  store: ConveyorStore;
  configHash: string;
  repository: Omit<RepositoryRecord, "configHash">;
  stages: readonly string[];
  labels: LabelConfiguration;
  source: Pick<IssueSourceAdapter, "listIssues">;
  expectedPostMergeClosure?: (issueId: string) => boolean;
}

export interface ReconcileRepositoryResult {
  seen: number;
  enrolled: number;
  offboarded: number;
  missing: number;
}

function isConveyorIssue(labels: readonly string[], enrollment: string): boolean {
  return labels.some(
    (label) => label === enrollment || label.startsWith(`${enrollment}:`),
  );
}

/**
 * Refresh the local read model from one complete source snapshot.
 *
 * This function only reads the source and updates SQLite. It deliberately performs no
 * source mutations, making polling safe even when an issue was just offboarded.
 */
export async function reconcileRepository(
  input: ReconcileRepositoryInput,
): Promise<ReconcileRepositoryResult> {
  input.store.upsertRepository({
    ...input.repository,
    configHash: input.configHash,
  });

  const sourceIssues = await input.source.listIssues(input.repository.address);
  const existing = new Map(
    input.store.listIssues(input.repository.id).map((issue) => [issue.id, issue]),
  );
  const seen = new Set<string>();
  let enrolled = 0;
  let offboarded = 0;

  for (const sourceIssue of sourceIssues) {
    seen.add(sourceIssue.id);
    const prior = existing.get(sourceIssue.id);
    const relevant = isConveyorIssue(
      sourceIssue.labels,
      input.labels.enrollment,
    );
    if (!relevant && !prior) continue;

    input.store.upsertIssue({
      id: sourceIssue.id,
      repositoryId: input.repository.id,
      sourceNumber: sourceIssue.number,
      sourceUrl: sourceIssue.url,
      title: sourceIssue.title,
      body: sourceIssue.body,
      sourceState: sourceIssue.state,
      labels: sourceIssue.labels,
      sourceUpdatedAt: sourceIssue.updatedAt,
    });

    const projected = evaluateIssueState({
      sourceState: sourceIssue.state,
      sourceLabels: sourceIssue.labels,
      labels: input.labels,
      stages: input.stages,
      expectedPostMergeClosure:
        input.expectedPostMergeClosure?.(sourceIssue.id) ?? false,
    });
    const projectedState = projected.state ?? projected.mode;
    input.store.setIssueProjection(sourceIssue.id, {
      stage: projected.visible ? projected.stage : null,
      state: projectedState,
      warning: projected.warnings.length > 0 ? projected.warnings.join("; ") : null,
    });

    if (!projected.visible) {
      input.store.endActiveEnrollment(sourceIssue.id, "offboarded");
    } else if (projected.mode === "active" && projected.stage) {
      const stageState = input.store.getStageState(sourceIssue.id);
      const awaitingDifferentStage =
        stageState?.status === "awaiting-source" &&
        stageState.stageId !== projected.stage;
      if (!awaitingDifferentStage && stageState?.status !== "running") {
        input.store.setStageState({
          issueId: sourceIssue.id,
          stageId: projected.stage,
          status: "ready",
          feedbackCycle: 0,
          configHash: input.configHash,
        });
      }
    }

    if (!prior && projected.visible) {
      input.store.setQueueRank(sourceIssue.id, input.store.nextQueueRank());
      enrolled += 1;
    } else if (prior && !projected.visible && prior.projectedState !== "offboarded") {
      offboarded += 1;
    }
  }

  let missing = 0;
  for (const issue of existing.values()) {
    if (seen.has(issue.id)) continue;
    input.store.setIssueProjection(issue.id, {
      stage: issue.projectedStage,
      state: "missing",
      warning: "Source issue was not returned; it may have been deleted or transferred.",
    });
    missing += 1;
  }

  return { seen: sourceIssues.length, enrolled, offboarded, missing };
}
