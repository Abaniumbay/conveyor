import type { LabelConfiguration } from "./issue-state";
import { evaluateIssueState } from "./issue-state";
import type { ConveyorStore, RepositoryRecord } from "../db/store";
import { ItemTodos } from "../engine/todos";
import { log } from "../log/logger";
import { isIssueGone } from "../source/types";
import type { IssueSourceAdapter, SourceEventActor, SourceIssue, SourceIssueProvenance } from "../source/types";

export interface RepositoryTrust {
  isTrusted(input: { address: string; login: string | null; extraTrustedLogins: readonly string[] }): Promise<boolean>;
}

export interface ReconcileRepositoryInput {
  store: ConveyorStore;
  configHash: string;
  repository: Omit<RepositoryRecord, "configHash">;
  stages: readonly string[];
  labels: LabelConfiguration;
  source: Pick<IssueSourceAdapter, "listIssues" | "getIssueProvenance"> & Partial<Pick<IssueSourceAdapter, "getIssue">>;
  trust: RepositoryTrust;
  extraTrustedLogins: readonly string[];
  expectedPostMergeClosure?: (issueId: string) => boolean;
  /** Read only issues updated since this time; issues not returned are left as they are rather than marked missing. */
  since?: string;
  /** Issue numbers named by a webhook, whose current source state must be read even if a recent listing omits them. */
  includeIssueNumbers?: readonly number[];
  /** Exactly these issues, already read: no listing, and nothing else is marked missing. */
  issues?: readonly SourceIssue[];
  /**
   * Re-read every enrolled issue's provenance and re-check its actors' permissions. Otherwise an
   * issue whose enrollment and accepted text are unchanged keeps its earlier trust decision.
   */
  verifyTrust?: boolean;
  /**
   * Per issue number, who made the change a webhook delivery reports. It stands in for the provenance
   * read when it answers every trust question the change raises.
   */
  delivered?: ReadonlyMap<number, DeliveredActors>;
  /**
   * Called synchronously for an item that left Conveyor, before anything else is read for it, so
   * the owner can stop the item's run and begin its purge. Without it the purge is only recorded.
   */
  onLeft?: (issueId: string) => void;
}

/** Who changed each trust-relevant part of an issue in one delivery; "unchanged" when it did not change it. */
export interface DeliveredActors {
  enrollment: SourceEventActor | "unchanged";
  title: SourceEventActor | "unchanged";
  body: SourceEventActor | "unchanged";
}

export interface ReconcileRepositoryResult {
  seen: number;
  enrolled: number;
  /** Items that had lost their Conveyor labels and were handed to the purge. */
  purged: number;
}

/** Projected states an item resumes from when its stopping label is removed (or enrolment restored). */
const STOPPED_STATES = new Set(["blocked", "error", "needs-input", "needs-intervention", "rejected", "paused", "waiting"]);

/** Whether the item moved forward from its prior stage, or finished altogether. */
function movedForward(
  stages: readonly string[],
  priorStage: string | null,
  stage: string | null,
  state: string | null,
): boolean {
  if (state === "done" || state === "completed") return true;
  const prior = priorStage === null ? -1 : stages.indexOf(priorStage);
  const current = stage === null ? -1 : stages.indexOf(stage);
  return prior >= 0 && current > prior;
}

type TrustDecision = { trusted: boolean; unavailable: boolean };

async function decideTrust(input: ReconcileRepositoryInput, actor: SourceEventActor | null): Promise<TrustDecision> {
  if (actor === null || actor.login === null) return { trusted: false, unavailable: false };
  try {
    return { trusted: await input.trust.isTrusted({
      address: input.repository.address,
      login: actor.login,
      extraTrustedLogins: input.extraTrustedLogins,
    }), unavailable: false };
  } catch {
    return { trusted: false, unavailable: true };
  }
}

function actorName(actor: SourceEventActor | null): string {
  return actor?.login === null || actor === null ? "" : ` by @${actor.login}`;
}

function enrollmentWarning(actor: SourceEventActor | null, unavailable: boolean): string {
  if (unavailable) return "Enrollment blocked: the conveyor label actor could not be verified.";
  if (actor === null || actor.login === null) return "Enrollment blocked: the conveyor label has no verifiable actor.";
  return `Enrollment blocked: the conveyor label was added by untrusted account @${actor.login}.`;
}

function textWarning(field: "title" | "body", actor: SourceEventActor | null, unavailable: boolean): string {
  if (unavailable) return `Ignored ${field} edit because its editor could not be verified; keeping the accepted ${field}.`;
  if (actor === null || actor.login === null) return `Ignored ${field} edit with no verifiable editor; keeping the accepted ${field}.`;
  return `Ignored untrusted ${field} edit${actorName(actor)}; keeping the accepted ${field}.`;
}

function rowFingerprint(row: ReturnType<ConveyorStore["getIssue"]> | undefined): string {
  return row ? JSON.stringify([row.id, row.title, row.body, row.acceptedTextAt ?? null, row.sourceUpdatedAt, row.sourceState, row.labels, row.warning]) : "";
}

async function acceptedSnapshot(input: ReconcileRepositoryInput, sourceIssue: SourceIssue, prior: ReturnType<ConveyorStore["getIssue"]> | undefined, enrolled: boolean): Promise<{
  title: string;
  body: string;
  acceptedTextAt: string | null;
  enrollmentTrusted: boolean;
  warnings: string[];
}> {
  if (!enrolled) {
    return { title: prior?.title ?? "", body: prior?.body ?? "", acceptedTextAt: prior?.acceptedTextAt ?? null, enrollmentTrusted: true, warnings: [] };
  }
  // Provenance answers who enrolled the issue and who wrote its text. An issue GitHub reports
  // unchanged since a trusted decision (same updated_at) cannot have a new labeler or editor, so
  // reading it again (three requests per issue) learns nothing.
  if (!input.verifyTrust && prior && prior.acceptedTextAt !== null && prior.acceptedTextAt !== undefined &&
    prior.sourceUpdatedAt === sourceIssue.updatedAt &&
    prior.labels.includes(input.labels.enrollment) && !(prior.warning ?? "").includes("Enrollment blocked") &&
    sourceIssue.title === prior.title && sourceIssue.body === prior.body) {
    return { title: prior.title, body: prior.body, acceptedTextAt: prior.acceptedTextAt, enrollmentTrusted: true, warnings: [] };
  }
  const priorTrusted = prior !== null && prior !== undefined && prior.acceptedTextAt !== null && prior.acceptedTextAt !== undefined &&
    prior.labels.includes(input.labels.enrollment) && !(prior.warning ?? "").includes("Enrollment blocked");
  // A delivery names who made its change. It answers every question when the enrollment is either
  // its own change or an earlier trusted one, and each text that differs was its own change.
  const delivered = input.verifyTrust ? undefined : input.delivered?.get(sourceIssue.number);
  // Without accepted text yet, a trusted enrollment adopts the issue's text as it is.
  const noAcceptedText = prior === null || prior === undefined || prior.acceptedTextAt === null || prior.acceptedTextAt === undefined;
  const answered = delivered !== undefined &&
    (delivered.enrollment !== "unchanged" || priorTrusted) &&
    (noAcceptedText || (["title", "body"] as const).every((field) => sourceIssue[field] === prior[field] || delivered[field] !== "unchanged"));
  // Source-event lookup is evidence, not a negative trust decision.  Propagate
  // an outage so the caller retries without replacing the existing projection.
  const provenance: { enrollment: SourceEventActor | "unchanged" | null; title: SourceEventActor | "unchanged" | null; body: SourceEventActor | "unchanged" | null } = answered
    ? delivered
    : await input.source.getIssueProvenance(input.repository.address, sourceIssue.number, input.labels.enrollment);
  const enrollment = provenance.enrollment === "unchanged" ? { trusted: true, unavailable: false } : await decideTrust(input, provenance.enrollment);
  if (!enrollment.trusted) {
    return {
      title: prior?.title ?? "", body: prior?.body ?? "", acceptedTextAt: prior?.acceptedTextAt ?? null,
      enrollmentTrusted: false,
      warnings: [enrollmentWarning(provenance.enrollment === "unchanged" ? null : provenance.enrollment, enrollment.unavailable)],
    };
  }
  if (prior === null || prior === undefined || prior.acceptedTextAt === null || prior.acceptedTextAt === undefined) {
    return { title: sourceIssue.title, body: sourceIssue.body, acceptedTextAt: sourceIssue.updatedAt, enrollmentTrusted: true, warnings: [] };
  }
  let title = prior.title;
  let body = prior.body;
  let acceptedTextAt = prior.acceptedTextAt;
  const warnings: string[] = [];
  for (const [field, value, actor] of [["title", sourceIssue.title, provenance.title], ["body", sourceIssue.body, provenance.body]] as const) {
    if (value === prior[field]) continue;
    // "unchanged" cannot reach here: a delivery answers only when each differing text was its own change.
    const editor = actor === "unchanged" ? null : actor;
    const decision = await decideTrust(input, editor);
    if (decision.trusted) {
      if (field === "title") title = value;
      else body = value;
      acceptedTextAt = sourceIssue.updatedAt;
    } else {
      warnings.push(textWarning(field, editor, decision.unavailable));
    }
  }
  return { title, body, acceptedTextAt: acceptedTextAt ?? null, enrollmentTrusted: true, warnings };
}

/**
 * Refresh the local read model from one complete source snapshot, or from the issues changed
 * `since` a time (which cannot tell a deleted issue from an unchanged one).
 *
 * This function only reads the source and updates SQLite. It deliberately performs no
 * source mutations, making polling safe even when an issue just left Conveyor.
 */
export async function reconcileRepository(
  input: ReconcileRepositoryInput,
): Promise<ReconcileRepositoryResult> {
  input.store.upsertRepository({
    ...input.repository,
    configHash: input.configHash,
  });

  let sourceIssues = input.issues
    ? [...input.issues]
    : await input.source.listIssues(input.repository.address, input.since !== undefined ? { since: input.since } : {});
  const goneNumbers: number[] = [];
  if (input.includeIssueNumbers && input.includeIssueNumbers.length > 0) {
    if (!input.source.getIssue) throw new Error("source adapter cannot refresh webhook-named issues");
    const refreshed = (await Promise.all(
      [...new Set(input.includeIssueNumbers)].map(async (number) => {
        try {
          return await input.source.getIssue!(input.repository.address, number);
        } catch (error) {
          // 404/410 proves the issue is gone; any other failure says nothing about it.
          if (isIssueGone(error)) {
            goneNumbers.push(number);
            return null;
          }
          log.warn("Webhook-named issue refresh failed", { repository: input.repository.id, issue: `${input.repository.address}:${number}` }, error);
          return null;
        }
      }),
    )).filter((issue) => issue !== null);
    const refreshedByNumber = new Map(refreshed.map((issue) => [issue.number, issue]));
    sourceIssues = sourceIssues.map((issue) => refreshedByNumber.get(issue.number) ?? issue);
    const listedNumbers = new Set(sourceIssues.map((issue) => issue.number));
    sourceIssues.push(...refreshed.filter((issue) => !listedNumbers.has(issue.number)));
  }
  const storedIssues = input.store.listIssues(input.repository.id);
  const existing = new Map(storedIssues.map((issue) => [issue.id, issue]));
  const existingByNumber = new Map(
    storedIssues.map((issue) => [issue.sourceNumber, issue]),
  );
  const fullListing = input.issues === undefined && input.since === undefined;
  const seen = new Set<string>();
  let enrolled = 0;
  let purged = 0;

  const purgeGone = (issueId: string): void => {
    if (input.store.isPurging(issueId)) return;
    if (input.onLeft) input.onLeft(issueId);
    else input.store.beginPurge(issueId);
    purged += 1;
  };
  for (const number of goneNumbers) {
    const stored = existingByNumber.get(number);
    if (stored && stored.projectedState !== "unlisted") purgeGone(stored.id);
  }

  for (const sourceIssue of sourceIssues) {
    // Source adapters may include a repository address in their IDs. Preserve
    // the stored identity when a repository is renamed or transferred so its
    // enrollments, runs, workspaces, relationships, and conversation remain
    // attached to the same issue.
    const prior =
      existing.get(sourceIssue.id) ?? existingByNumber.get(sourceIssue.number);
    const issueId = prior?.id ?? sourceIssue.id;
    seen.add(issueId);
    if (fullListing && prior && sourceIssue.updatedAt < prior.sourceUpdatedAt) continue;
    const hasEnrollment = sourceIssue.labels.includes(input.labels.enrollment);
    // An issue without the Conveyor label does not exist for Conveyor. One Conveyor knows is purged;
    // a dependency stub (unlisted, not being purged) keeps being refreshed but stays unlisted.
    if (!hasEnrollment) {
      if (!prior) continue;
      if (input.store.isPurging(issueId)) continue;
      if (prior.projectedState !== "unlisted") {
        if (input.onLeft) input.onLeft(issueId);
        else input.store.beginPurge(issueId);
        purged += 1;
        continue;
      }
    }
    // A purge in progress finishes first; the issue is onboarded afresh once its rows are gone.
    if (input.store.isPurging(issueId)) continue;
    // The snapshot awaits the source; a row stored meanwhile (a delivery, another pass) must not
    // be overwritten from the earlier read, so decide again against the current row.
    let current = prior;
    let snapshot = await acceptedSnapshot(input, sourceIssue, current, hasEnrollment);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const fresh = input.store.getIssue(issueId) ?? input.store.getIssueByNumber(input.repository.id, sourceIssue.number) ?? undefined;
      if (rowFingerprint(fresh) === rowFingerprint(current)) break;
      current = fresh;
      snapshot = await acceptedSnapshot(input, sourceIssue, current, hasEnrollment);
    }

    input.store.upsertIssue({
      id: issueId,
      repositoryId: input.repository.id,
      sourceNumber: sourceIssue.number,
      sourceUrl: sourceIssue.url,
      title: snapshot.title,
      body: snapshot.body,
      sourceState: sourceIssue.state,
      sourceStateReason: sourceIssue.stateReason ?? null,
      labels: sourceIssue.labels,
      sourceUpdatedAt: sourceIssue.updatedAt,
      acceptedTextAt: snapshot.acceptedTextAt,
      ...(sourceIssue.type !== undefined ? { issueType: sourceIssue.type } : {}),
    });

    const projected = evaluateIssueState({
      sourceState: sourceIssue.state,
      sourceLabels: sourceIssue.labels,
      labels: input.labels,
      stages: input.stages,
      expectedPostMergeClosure:
        (input.expectedPostMergeClosure?.(issueId) ?? false) ||
        // A roll-up reaches done before Conveyor closes it with GitHub's completed reason.
        // That final source delivery confirms the result; it must not turn the completed parent
        // into an uncorrelated manual closure.
        (current?.projectedState === "done" && sourceIssue.state === "closed" && sourceIssue.stateReason === "completed"),
    });
    // A question is durable local state. Source updates which race with relationship
    // roll-up must not turn its parked owner back into an active item.
    const openQuestion = input.store.listOpenQuestions().find((question) => question.issueId === issueId);
    const questionRun = openQuestion?.runId ? input.store.getRun(openQuestion.runId) : null;
    const visible = projected.visible;
    const eligible = visible && snapshot.enrollmentTrusted;
    const projectedState = !visible
      ? "unlisted"
      : !snapshot.enrollmentTrusted ? "waiting"
      // The paused label wins over a parked question: the question stays open, nothing runs.
      : projected.mode === "paused" ? "paused"
      : openQuestion ? "needs-input" : projected.state ?? projected.mode;
    const projectedStage = openQuestion
      ? questionRun?.stageId ?? current?.projectedStage ?? projected.stage
      : projected.stage;
    const priorState = current?.projectedState ?? null;
    if (projectedState === "paused" && priorState !== "paused") {
      input.store.recordJourneyEvent({
        issueId,
        stage: projected.stage,
        kind: "paused",
        reason: `Paused: the ${input.labels.metadata.paused} label is present.`,
      });
    }
    const resumed = projectedState === "active" && priorState !== null && STOPPED_STATES.has(priorState);
    if (resumed) {
      input.store.recordJourneyEvent({
        issueId,
        stage: projected.stage,
        kind: "resumed",
        reason: priorState === "paused"
          ? `Resumed: the ${input.labels.metadata.paused} label was removed.`
          : `Resumed from ${priorState}: the ${priorState} label was removed.`,
      });
    }
    input.store.setIssueProjection(issueId, {
      stage: visible ? projectedStage : null,
      state: projectedState,
      warning: [...projected.warnings, ...snapshot.warnings].join("; ") || null,
    });

    // A process can stop after the source labels advance but before its local transition commits.
    // Reconciliation observes that durable source checkpoint and completes the idempotent closeout.
    if (eligible && movedForward(input.stages, current?.projectedStage ?? null, projected.stage, projected.state)) {
      new ItemTodos(input.store.sqlite()).closeOut(issueId);
    }

    if (!visible) {
      // A dependency stub: never enrolled, nothing to end.
    } else if (!snapshot.enrollmentTrusted) {
      input.store.endActiveEnrollment(issueId, "trust-blocked");
    } else if (!openQuestion && projected.mode === "active" && projected.stage) {
      const stageState = input.store.getStageState(issueId);
      const awaitingDifferentStage =
        stageState?.status === "awaiting-source" &&
        stageState.stageId !== projected.stage;
      // A stage that failed is resumed by its retry backoff; a reconcile (for example the webhook of
      // Conveyor's own status-comment update) must not restart it at once, which bypassed the backoff.
      // Once retries are used up the stage stays in error under a stopped label, and nothing else
      // resumes it: removing that label (Retry, or a person on GitHub) must make it ready again.
      const backingOff = !resumed && stageState?.status === "error" && stageState.stageId === projected.stage;
      const waitingForInFlight = stageState?.status === "waiting-in-flight" && stageState.stageId === projected.stage;
      // An explicit child-creation retry is admitted by the scheduler from this durable marker.
      // Reconciliation must not replace it with ready before the scheduler claims it.
      const childCreationRetry = stageState?.status === "retry-ready" && stageState.stageId === projected.stage;
      if (!awaitingDifferentStage && !backingOff && !waitingForInFlight && !childCreationRetry && stageState?.status !== "running") {
        input.store.setStageState({
          issueId,
          stageId: projected.stage,
          status: "ready",
          feedbackCycle: 0,
          configHash: input.configHash,
        });
      }
    }

    // Dependencies are stored before their own repository snapshot is read. A visible item
    // without a rank has therefore never completed onboarding, even when it already has a row.
    if (eligible && (current === undefined || current.queueRank === null)) {
      input.store.setQueueRank(issueId, input.store.nextQueueRank());
      input.store.recordJourneyEvent({
        issueId,
        stage: projected.stage,
        kind: "onboarded",
        reason: `Enrolled: the ${input.labels.enrollment} label was added${projected.stage ? ` at ${projected.stage}` : ""}.`,
      });
      enrolled += 1;
    }
  }

  // A full listing that omits a stored issue proves nothing: confirm it by number. Only 404/410 purges;
  // any other failure leaves the item as it is, and nothing is ever marked missing.
  if (fullListing && input.source.getIssue) {
    for (const stored of storedIssues) {
      if (seen.has(stored.id) || stored.projectedState === "unlisted" || input.store.isPurging(stored.id)) continue;
      if (!input.store.getIssue(stored.id)) continue;
      try {
        await input.source.getIssue(input.repository.address, stored.sourceNumber);
      } catch (error) {
        if (isIssueGone(error)) purgeGone(stored.id);
        else log.warn("Issue missing from the listing could not be confirmed", { repository: input.repository.id, issue: stored.id }, error);
      }
    }
  }

  return { seen: sourceIssues.length, enrolled, purged };
}
