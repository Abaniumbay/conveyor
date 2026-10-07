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
  /** Read only issues updated since this time; issues not returned are left as they are rather than marked missing. */
  since?: string;
}

export interface ReconcileRepositoryResult {
  seen: number;
  enrolled: number;
  offboarded: number;
  missing: number;
}

/** Projected states an item resumes from when its stopping label is removed (or enrolment restored). */
const STOPPED_STATES = new Set(["blocked", "error", "needs-input", "needs-intervention", "rejected", "paused", "waiting"]);

function isConveyorIssue(labels: readonly string[], enrollment: string): boolean {
  return labels.some(
    (label) => label === enrollment || label.startsWith(`${enrollment}:`),
  );
}

/**
 * Refresh the local read model from one complete source snapshot, or from the issues changed
 * `since` a time (which cannot tell a deleted issue from an unchanged one).
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

  const sourceIssues = await input.source.listIssues(input.repository.address, input.since !== undefined ? { since: input.since } : {});
  const storedIssues = input.store.listIssues(input.repository.id);
  const existing = new Map(storedIssues.map((issue) => [issue.id, issue]));
  const existingByNumber = new Map(
    storedIssues.map((issue) => [issue.sourceNumber, issue]),
  );
  const seen = new Set<string>();
  let enrolled = 0;
  let offboarded = 0;

  for (const sourceIssue of sourceIssues) {
    // Source adapters may include a repository address in their IDs. Preserve
    // the stored identity when a repository is renamed or transferred so its
    // enrollments, runs, workspaces, relationships, and conversation remain
    // attached to the same issue.
    const prior =
      existing.get(sourceIssue.id) ?? existingByNumber.get(sourceIssue.number);
    const issueId = prior?.id ?? sourceIssue.id;
    seen.add(issueId);
    const relevant = isConveyorIssue(
      sourceIssue.labels,
      input.labels.enrollment,
    );
    if (!relevant && !prior) continue;

    input.store.upsertIssue({
      id: issueId,
      repositoryId: input.repository.id,
      sourceNumber: sourceIssue.number,
      sourceUrl: sourceIssue.url,
      title: sourceIssue.title,
      body: sourceIssue.body,
      sourceState: sourceIssue.state,
      sourceStateReason: sourceIssue.stateReason ?? null,
      labels: sourceIssue.labels,
      sourceUpdatedAt: sourceIssue.updatedAt,
      ...(sourceIssue.type !== undefined ? { issueType: sourceIssue.type } : {}),
    });

    const projected = evaluateIssueState({
      sourceState: sourceIssue.state,
      sourceLabels: sourceIssue.labels,
      labels: input.labels,
      stages: input.stages,
      expectedPostMergeClosure:
        input.expectedPostMergeClosure?.(issueId) ?? false,
    });
    const projectedState = projected.state ?? projected.mode;
    const priorState = prior?.projectedState ?? null;
    const resumed = projectedState === "active" && priorState !== null && STOPPED_STATES.has(priorState);
    if (resumed) {
      input.store.recordJourneyEvent({
        issueId,
        stage: projected.stage,
        kind: "resumed",
        reason: priorState === "paused"
          ? `Resumed: the ${input.labels.enrollment} label was added back.`
          : `Resumed from ${priorState}: the ${priorState} label was removed.`,
      });
    }
    input.store.setIssueProjection(issueId, {
      stage: projected.visible ? projected.stage : null,
      state: projectedState,
      warning: projected.warnings.length > 0 ? projected.warnings.join("; ") : null,
    });

    if (!projected.visible) {
      input.store.endActiveEnrollment(issueId, "offboarded");
    } else if (projected.mode === "active" && projected.stage) {
      const stageState = input.store.getStageState(issueId);
      const awaitingDifferentStage =
        stageState?.status === "awaiting-source" &&
        stageState.stageId !== projected.stage;
      // A stage that failed is resumed by its retry backoff; a reconcile (for example the webhook of
      // Conveyor's own status-comment update) must not restart it at once, which bypassed the backoff.
      // Once retries are used up the stage stays in error under a stopped label, and nothing else
      // resumes it: removing that label (Retry, or a person on GitHub) must make it ready again.
      const backingOff = !resumed && stageState?.status === "error" && stageState.stageId === projected.stage;
      if (!awaitingDifferentStage && !backingOff && stageState?.status !== "running") {
        input.store.setStageState({
          issueId,
          stageId: projected.stage,
          status: "ready",
          feedbackCycle: 0,
          configHash: input.configHash,
        });
      }
    }

    if (!prior && projected.visible) {
      input.store.setQueueRank(issueId, input.store.nextQueueRank());
      input.store.recordJourneyEvent({
        issueId,
        stage: projected.stage,
        kind: "onboarded",
        reason: `Enrolled: the ${input.labels.enrollment} label was added${projected.stage ? ` at ${projected.stage}` : ""}.`,
      });
      enrolled += 1;
    } else if (prior && !projected.visible && prior.projectedState !== "offboarded") {
      offboarded += 1;
    }
  }

  let missing = 0;
  for (const issue of existing.values()) {
    if (input.since !== undefined || seen.has(issue.id)) continue;
    input.store.setIssueProjection(issue.id, {
      stage: issue.projectedStage,
      state: "missing",
      warning: "Source issue was not returned; it may have been deleted or transferred.",
    });
    missing += 1;
  }

  return { seen: sourceIssues.length, enrolled, offboarded, missing };
}
