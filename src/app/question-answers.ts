// Questions and answers (#676): accepting an answer to an agent's question, clearing the item's
// needs-input state so the parked agent resumes, and mirroring the answer to the source. A
// scheduled Operator's answer is accepted only once its mirror succeeded, so it can be finished
// after a restart.

import type { ConveyorConfig } from "../config/load";
import { RepositoryPausedError } from "../core/repository-pause";
import type { ConversationStore, EventStore, ItemStore, JournalStore, RunLogStore } from "../db/ports";
import type { StoredIssue, StoredQuestion } from "../db/store";
import { log, type LogFields } from "../log/logger";
import { validatedQuestionAnswer } from "../questions";
import type { StatusComments } from "../source/client";
import type { ItemComments, ItemMarkers } from "../source/types";

type Repository = Pick<ConveyorConfig["repositories"][string], "source" | "address">;

export interface QuestionAnswerDeps {
  config: { labels: ConveyorConfig["labels"]; repositories: Readonly<Record<string, Repository>> };
  store: Pick<ConversationStore, "getQuestion" | "recordQuestionAnswer" | "recordQuestionAnswerWithConversation" | "completeQuestionAnswer" | "listOpenQuestions">
    & Pick<ItemStore, "getIssue" | "repositoryPause" | "setIssueProjection">
    & Pick<RunLogStore, "getRun">
    & Pick<JournalStore, "beginSourceMutation" | "completeSourceMutation" | "failSourceMutation" | "getSourceMutationByKey">
    & EventStore;
  /** The item source fenced at the repository's pause. */
  source: (repositoryId: string) => Pick<ItemMarkers, "replaceConveyorLabels"> & ItemComments & Pick<StatusComments, "hasCommentWithMarker">;
  /** Wakes the item when its cursor is parked on the agent that asked; false when it is not. */
  wakeParkedAgent: (question: StoredQuestion) => boolean;
  schedule: () => void;
  /** Reads the one item from the source again. */
  reconcile: (repositoryId: string, sourceNumber: number) => Promise<void>;
  updateStatusComment: (issueId: string) => Promise<void>;
  shuttingDown: () => boolean;
  /** Log correlation for an item. */
  itemFields: (issueId: string) => LogFields;
}

/** Conveyor's metadata labels among an item's labels: those a relabel keeps. */
export function metadataLabels(sourceLabels: readonly string[], config: Pick<ConveyorConfig, "labels">): string[] {
  const orderPrefix = config.labels.metadata.orderTemplate.split("{number}")[0]!;
  return sourceLabels.filter((label) =>
    label === config.labels.metadata.closable ||
    label === config.labels.metadata.noSplit ||
    label.startsWith(orderPrefix),
  );
}

function questionAnswerText(answer: unknown): string | null {
  if (typeof answer === "string") return answer;
  if (!answer || typeof answer !== "object") return null;
  const value = (answer as { answer?: unknown }).answer;
  return typeof value === "string" ? value : null;
}

function questionAnswerEvidence(answer: unknown): string | null {
  if (!answer || typeof answer !== "object") return null;
  const value = (answer as { evidence?: unknown }).evidence;
  return typeof value === "string" ? value : null;
}

/** Accepts answers to agents' questions and finishes the work each answer starts. */
export class QuestionAnswers {
  readonly #deps: QuestionAnswerDeps;
  /** Live answer mirrors are guarded in memory; persisted pending mutations can be retried after a restart. */
  readonly #mirrorsInFlight = new Set<string>();
  readonly #scheduledCompletions = new Map<string, Promise<void>>();
  /** Background work after an answer: settled before the service closes, and awaitable in tests. */
  readonly #followUps = new Set<Promise<void>>();
  /** Tests shorten the pauses between answer-mirror retries. */
  retryDelayMs: number | null = null;

  constructor(deps: QuestionAnswerDeps) {
    this.#deps = deps;
  }

  /** Whether an answer's background work is still running. */
  get busy(): boolean {
    return this.#followUps.size > 0;
  }

  /** Resolves once every answer's background work (comment, re-sync, status) has finished. */
  async followUpsSettled(): Promise<void> {
    while (this.#followUps.size > 0) await Promise.all([...this.#followUps]);
  }

  async answer(questionId: string, answer: string, source = "web", evidence?: string): Promise<void> {
    const { config, store } = this.#deps;
    const question = store.getQuestion(questionId);
    if (!question) throw new Error("question not found");
    const issue = store.getIssue(question.issueId);
    if (issue?.projectedState === "unlisted") {
      throw new Error("This question belongs to an item that left Conveyor.");
    }
    if (issue) this.#assertRepositoryActive(issue.repositoryId);
    const response = validatedQuestionAnswer(question, answer);
    if (question.status !== "open") throw new Error("This question has already been answered.");
    if (question.answer !== null) {
      const prior = typeof question.answer === "object" && question.answer !== null
        ? (question.answer as { answer?: unknown }).answer
        : question.answer;
      if (prior !== response) throw new Error("This question already has a pending answer; retry the same answer.");
      if (source.startsWith("scheduled-operator:") && !question.answerSource?.startsWith("scheduled-operator:")) {
        throw new Error("This question already has a pending owner answer.");
      }
      if (!source.startsWith("scheduled-operator:") && question.answerSource?.startsWith("scheduled-operator:")) {
        throw new Error("This question has a scheduled answer pending its source mirror.");
      }
    }
    const scheduled = source.startsWith("scheduled-operator:");
    if (scheduled) {
      // The source mutation must succeed before this becomes an accepted, resume-worthy answer.
      // Keep the response and its evidence durable so reconciliation can finish that mutation later.
      store.recordQuestionAnswer(questionId, source, { answer: response, evidence: evidence ?? null });
    } else {
      const runStage = question.runId ? store.getRun(question.runId)?.stageId : null;
      store.recordQuestionAnswerWithConversation({
        questionId,
        source,
        answer: { answer: response },
        stageId: runStage ?? issue?.projectedStage ?? null,
        message: `**Question:** ${question.prompt}\n\n**Accepted answer:** ${response}`,
      });
    }
    if (!issue) return;
    const repository = config.repositories[issue.repositoryId];
    if (!repository) return;
    if (scheduled) {
      await this.#completeScheduledAnswer(question, issue, repository, response);
      return;
    }
    await this.#finalize(question, issue, repository);
    this.#trackFollowUp(this.#followUp(
      issue.id, question.id, response, repository.address, issue.sourceNumber, repository.source,
    ).then(() => undefined));
  }

  /** Finishes scheduled answers whose source mirror had not succeeded, after a reconcile or restart. */
  recoverPendingScheduled(): void {
    const { config, store } = this.#deps;
    for (const question of store.listOpenQuestions()) {
      if (!question.answerSource?.startsWith("scheduled-operator:")) continue;
      const response = questionAnswerText(question.answer);
      const issue = store.getIssue(question.issueId);
      const repository = issue && config.repositories[issue.repositoryId];
      if (!response || !issue || !repository || issue.projectedState === "unlisted") continue;
      this.#trackFollowUp(this.#completeScheduledAnswer(question, issue, repository, response));
    }
  }

  #assertRepositoryActive(repositoryId: string): void {
    if (this.#deps.store.repositoryPause(repositoryId)) throw new RepositoryPausedError();
  }

  async #finalize(question: StoredQuestion, issue: StoredIssue, repository: Repository): Promise<void> {
    const { config, store } = this.#deps;
    this.#assertRepositoryActive(issue.repositoryId);
    const github = this.#deps.source(issue.repositoryId);
    // Before replying, only what resuming needs: the source's needs-input label goes first (a sync
    // that still saw it would stop the item again), then the parked agent wakes. Mirroring the answer
    // as a comment, re-syncing the repository and the status comment follow in the background.
    const needsInput = config.labels.states["needs-input"];
    const hadNeedsInput = Boolean(needsInput && issue.labels.includes(needsInput));
    if (hadNeedsInput) {
      const runStage = question.runId ? store.getRun(question.runId)?.stageId : null;
      const stage = runStage ?? issue.projectedStage;
      const metadata = metadataLabels(issue.labels, config);
      try {
        await github.replaceConveyorLabels(repository.address, issue.sourceNumber, [
          config.labels.enrollment,
          ...(stage ? [config.labels.stageTemplate.replace("{stage}", stage)] : []),
          ...metadata,
        ], [config.labels.metadata.noSplit, config.labels.metadata.paused]);
      } catch (error) {
        if (error instanceof RepositoryPausedError) throw error;
        throw new Error("Your answer was saved but the question state could not be cleared. Submit the same answer to retry.");
      }
    }
    store.completeQuestionAnswer(question.id);
    // A stage parked on an agent's question continues where it stopped; legacy stages restart.
    const parkedAgentWoken = this.#deps.wakeParkedAgent(question);
    const runStage = question.runId ? store.getRun(question.runId)?.stageId : null;
    const resumedStage = runStage ?? issue.projectedStage;
    if (resumedStage) {
      // A native agent can park without first writing needs-input to the source. Clear its local
      // projection before scheduling; with the step parked this keeps it (see setIssueProjection).
      store.setIssueProjection(issue.id, { stage: resumedStage, state: "active", warning: null });
    }
    if (!parkedAgentWoken && issue.projectedStage) {
      const metadata = metadataLabels(issue.labels, config);
      await github.replaceConveyorLabels(repository.address, issue.sourceNumber, [
        config.labels.enrollment,
        config.labels.stageTemplate.replace("{stage}", issue.projectedStage),
        ...metadata,
      ], [config.labels.metadata.noSplit, config.labels.metadata.paused]);
    }
    this.#deps.schedule();
  }

  async #completeScheduledAnswer(
    question: StoredQuestion,
    issue: StoredIssue,
    repository: Repository,
    response: string,
  ): Promise<void> {
    const existing = this.#scheduledCompletions.get(question.id);
    if (existing) return existing;
    const { store } = this.#deps;
    const completion = (async () => {
      const mirrored = await this.#followUp(
        issue.id, question.id, response, repository.address, issue.sourceNumber, repository.source, true,
      );
      if (!mirrored) {
        throw new Error("Scheduled answer is pending source mirror; it will retry after reconciliation.");
      }
      const current = store.getQuestion(question.id);
      if (!current || current.status !== "open") return;
      const evidence = questionAnswerEvidence(current.answer);
      store.recordQuestionAnswerWithConversation({
        questionId: current.id,
        source: current.answerSource ?? "scheduled-operator:recovery",
        answer: current.answer,
        stageId: current.runId ? store.getRun(current.runId)?.stageId ?? issue.projectedStage : issue.projectedStage,
        message: `**Scheduled Operator question answer:** ${current.prompt}\n\n**Accepted answer:** ${response}\n\n**Evidence:** ${evidence ?? "recorded by scheduled Operator"}`,
        actor: { type: "conveyor", id: current.answerSource ?? "scheduled-operator:recovery", name: "Scheduled Operator", title: "Conveyor Operator" },
      });
      await this.#finalize(current, issue, repository);
    })().finally(() => this.#scheduledCompletions.delete(question.id));
    this.#scheduledCompletions.set(question.id, completion);
    return completion;
  }

  #trackFollowUp(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => log.warn("Answer follow-up failed", {}, error)).finally(() => this.#followUps.delete(tracked));
    this.#followUps.add(tracked);
  }

  async #followUp(issueId: string, questionId: string, response: string, address: string, sourceNumber: number, source: string, scheduled = false): Promise<boolean> {
    const { store } = this.#deps;
    const issue = store.getIssue(issueId);
    if (!issue || store.repositoryPause(issue.repositoryId)) return false;
    const github = this.#deps.source(issue.repositoryId);
    // The answer is mirrored as an issue comment once, retried a few times when the source is unavailable.
    const mirrorKey = `question-answer:${questionId}`;
    if (!this.#mirrorsInFlight.has(mirrorKey)) {
      this.#mirrorsInFlight.add(mirrorKey);
      try {
        for (const [attempt, delayMs] of [0, 2_000, 10_000].entries()) {
          if (delayMs > 0) await Bun.sleep(this.retryDelayMs ?? delayMs);
          if (this.#deps.shuttingDown() && attempt > 0) break;
          const mirror = store.beginSourceMutation({
            idempotencyKey: mirrorKey,
            source,
            operation: "issue.comment.answer",
            request: { issueId, questionId, answer: response, actor: scheduled ? "scheduled-operator" : "owner" },
          });
          if (mirror.status === "succeeded") break;
          try {
            const marker = `<!-- conveyor:answer:${questionId} -->`;
            const sourceHasAnswer = typeof github.hasCommentWithMarker === "function" &&
              await github.hasCommentWithMarker(address, sourceNumber, marker);
            if (!sourceHasAnswer) await github.addComment(address, sourceNumber, `${marker}\n**${scheduled ? "Scheduled Operator answer" : "Conveyor answer"}:** ${response}`);
            store.completeSourceMutation(mirror.id, { questionId });
            break;
          } catch (error) {
            if (error instanceof RepositoryPausedError) return false;
            store.failSourceMutation(mirror.id, error instanceof Error ? error.message : String(error));
            log.warn("Could not mirror an answer to the source; retrying", { ...this.#deps.itemFields(issueId), attempt: attempt + 1 }, error);
          }
        }
      } finally {
        this.#mirrorsInFlight.delete(mirrorKey);
      }
    }
    const mirrored = store.getSourceMutationByKey(mirrorKey)?.status === "succeeded";
    try {
      // Reconciliation is needed after every answer, not only when the stale source snapshot happened
      // to include the needs-input label.
      const answered = store.getIssue(issueId);
      if (answered) await this.#deps.reconcile(answered.repositoryId, answered.sourceNumber);
    } catch (error) {
      log.warn("Question answer reconciliation failed; the parked run remains resumable", this.#deps.itemFields(issueId), error);
    }
    await this.#deps.updateStatusComment(issueId);
    this.#deps.schedule();
    store.events().append("item.requeued", { reason: "answer" }, { issueId });
    return mirrored;
  }
}
