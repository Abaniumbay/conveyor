// Status comments (#676): Conveyor's one comment on each enrolled item, saying where it stands.
// Writes for one item are queued so concurrent work never posts two comments or lets an older
// snapshot win, and each write is recorded as a source mutation keyed by its content.

import { createHash } from "node:crypto";

import type { ConveyorConfig } from "../config/load";
import { STOPPED_ISSUE_STATES } from "../core/issue-state";
import { RepositoryPausedError } from "../core/repository-pause";
import type { ConversationStore, ItemStore, JournalStore, RunLogStore } from "../db/ports";
import type { StoredIssue } from "../db/store";
import type { StatusComments } from "../source/client";
import { renderStatusComment } from "../source/status-comment";
import type { LiveIssueStatus } from "./dashboard-sources";

export interface StatusCommentDeps {
  config: {
    labels: Pick<ConveyorConfig["labels"], "enrollment">;
    repositories: Readonly<Record<string, Pick<ConveyorConfig["repositories"][string], "source" | "address">>>;
  };
  store: Pick<ItemStore, "getIssue" | "repositoryPause" | "listChildren" | "listDependencies">
    & Pick<JournalStore, "getStageState" | "beginSourceMutation" | "completeSourceMutation" | "failSourceMutation">
    & Pick<RunLogStore, "latestRunSummary">
    & Pick<ConversationStore, "listOpenQuestions">;
  /** The item source fenced at the repository's pause. */
  source: (repositoryId: string) => Pick<StatusComments, "upsertStatusComment">;
  /** Reads the open change's live head first, so the criteria agree with the review gate even when a webhook was delayed. */
  refreshChangeHead: (issue: StoredIssue) => Promise<void>;
  /** The item's acceptance criteria and whether each is approved at the current head. */
  criteria: (issue: StoredIssue) => ReadonlyArray<{ text: string; approved: boolean }>;
  /** Why the item waits or is queued now; null when it does neither. */
  status: (issue: StoredIssue) => LiveIssueStatus | null;
  /** The recorded reason of the item's latest stop. */
  stopReason: (issueId: string) => string | null;
}

/**
 * The status line of the issue's status comment. Only the status itself: times that move on their
 * own (the next check, how long it has been queued) would rewrite the comment without any change.
 */
function statusCommentText(status: LiveIssueStatus): string {
  return `${status.kind === "queued" ? "Queued" : "Waiting"} · ${status.reason}`;
}

/** Writes each enrolled item's status comment, one write per item at a time. */
export class StatusCommentWriter {
  readonly #deps: StatusCommentDeps;
  readonly #updates = new Set<Promise<void>>();
  readonly #updatesByIssue = new Map<string, Promise<void>>();
  /** The status-comment digest last written by this process, so a revert to older content is still written. */
  readonly #digests = new Map<string, string>();
  /** The status comment of each issue, as last written, so an update goes straight to it without listing comments. */
  readonly #commentIds = new Map<string, number>();

  constructor(deps: StatusCommentDeps) {
    this.#deps = deps;
  }

  /** Whether a write is still in flight. */
  get busy(): boolean {
    return this.#updates.size > 0;
  }

  /**
   * Queue comment writes for an issue so concurrent scheduling and webhook work cannot create
   * duplicate source comments or allow an older snapshot to win the race.
   */
  update(issueId: string): Promise<void> {
    const previous = this.#updatesByIssue.get(issueId) ?? Promise.resolve();
    const update = previous
      .catch(() => {})
      .then(() => this.#write(issueId));
    this.#updatesByIssue.set(issueId, update);
    this.#updates.add(update);
    const complete = () => {
      this.#updates.delete(update);
      if (this.#updatesByIssue.get(issueId) === update) {
        this.#updatesByIssue.delete(issueId);
      }
    };
    void update.then(complete, complete);
    return update;
  }

  async #write(issueId: string): Promise<void> {
    const { config, store } = this.#deps;
    const issue = store.getIssue(issueId);
    if (!issue) return;
    if (store.repositoryPause(issue.repositoryId)) return;
    const relevant = issue.labels.some(
      (label) =>
        label === config.labels.enrollment ||
        label.startsWith(`${config.labels.enrollment}:`),
    );
    if (!relevant) return;
    const repository = config.repositories[issue.repositoryId];
    if (!repository) return;
    const stageState = store.getStageState(issue.id);
    const latestRun = store.latestRunSummary(issue.id);
    const questions = store
      .listOpenQuestions()
      .filter((question) => question.issueId === issue.id)
      .map((question) => question.prompt);
    const children = store.listChildren(issue.id).flatMap(({ issueId: childId }) => {
      const child = store.getIssue(childId);
      return child ? [{ number: child.sourceNumber, title: child.title }] : [];
    });
    const dependencies = store.listDependencies(issue.id).flatMap((blockerId) => {
      const blocker = store.getIssue(blockerId);
      return blocker
        ? [{ number: blocker.sourceNumber, title: blocker.title, state: blocker.projectedState ?? blocker.sourceState }]
        : [];
    });
    await this.#deps.refreshChangeHead(issue);
    const acceptanceCriteria = this.#deps.criteria(issue).map(({ text, approved }) => ({ text, passed: approved }));
    const status = this.#deps.status(issue);
    // A stopped item says why on its issue: the recorded stop reason, so the owner knows what to do.
    const blocker = status || !STOPPED_ISSUE_STATES.has(issue.projectedState ?? "") ? null : this.#deps.stopReason(issue.id);
    const markdown = renderStatusComment({
      issue: { number: issue.sourceNumber, title: issue.title, state: issue.sourceState },
      stage: issue.projectedStage ?? "unassigned",
      state: issue.projectedState ?? "unknown",
      ...(status ? { status: statusCommentText(status) } : {}),
      ...(blocker ? { blocker } : {}),
      ...(stageState
        ? { activity: `${stageState.stageId} · ${stageState.status}` }
        : {}),
      acceptanceCriteria,
      children,
      dependencies,
      ...(latestRun
        ? { latestRun: {
            id: latestRun.id,
            state: latestRun.status,
            durationMs: latestRun.durationMs,
            usage: {
              inputTokens: latestRun.inputTokens,
              outputTokens: latestRun.outputTokens,
            },
            costUsd:
              latestRun.costSource === "unavailable" ? null : latestRun.amount,
          } }
        : {}),
      questions,
      warnings: !status && issue.warning ? [issue.warning] : [],
    });
    const digest = createHash("sha256").update(markdown).digest("hex");
    const mutation = store.beginSourceMutation({
      idempotencyKey: `status:${issue.id}:${digest}`,
      source: repository.source,
      operation: "comment.status.upsert",
      request: { issueId: issue.id, digest },
    });
    // A succeeded mutation only proves this content was written once; the remote comment may
    // have moved on since (checked, then unchecked), so skip only when it is the last write.
    if (mutation.status === "succeeded" && this.#digests.get(issue.id) === digest) return;
    try {
      const commentId = await this.#deps.source(issue.repositoryId).upsertStatusComment(
        repository.address,
        issue.sourceNumber,
        markdown,
        this.#commentIds.get(issue.id),
      );
      store.completeSourceMutation(mutation.id, { commentId });
      this.#digests.set(issue.id, digest);
      this.#commentIds.set(issue.id, commentId);
    } catch (error) {
      if (error instanceof RepositoryPausedError) throw error;
      store.failSourceMutation(mutation.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}
