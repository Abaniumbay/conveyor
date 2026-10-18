import type { StoredIssue, ConveyorStore } from "../db/store";
import type { StageExecutionResult } from "./pipeline";
import type { LabelConfiguration } from "./issue-state";
import { RepositoryPausedError } from "./repository-pause";
import { ItemTodos, TODO_OWNING_STAGE } from "../engine/todos";

export interface TransitionSource {
  replaceConveyorLabels(
    address: string,
    issueNumber: number,
    labels: readonly string[],
    preserveLabels?: readonly string[],
  ): Promise<void>;
}

export interface ApplyStageTransitionInput {
  store: ConveyorStore;
  source: TransitionSource;
  sourceName: string;
  address: string;
  configHash: string;
  transitionId: string;
  issue: StoredIssue;
  stages: readonly string[];
  labels: LabelConfiguration;
  result: StageExecutionResult;
  actor?: { name: string; title: string | null };
}

export interface ApplyRollupTransitionInput {
  store: ConveyorStore;
  source: TransitionSource;
  sourceName: string;
  address: string;
  configHash: string;
  transitionId: string;
  issue: StoredIssue;
  targetStageId: string;
  labels: LabelConfiguration;
  reason: string;
}

export interface ApplyClosedItemOffboardingInput {
  store: ConveyorStore;
  source: TransitionSource;
  sourceName: string;
  address: string;
  transitionId: string;
  issue: StoredIssue;
}

function matchesTemplate(label: string, template: string, token: string): boolean {
  const [prefix, suffix = ""] = template.split(`{${token}}`);
  return label.startsWith(prefix ?? "") && label.endsWith(suffix) &&
    label.length > (prefix?.length ?? 0) + suffix.length;
}

function metadataLabels(
  sourceLabels: readonly string[],
  labels: LabelConfiguration,
): string[] {
  return sourceLabels.filter(
    (label) =>
      label === labels.metadata.closable ||
      label === labels.metadata.noSplit ||
      matchesTemplate(label, labels.metadata.orderTemplate, "number"),
  );
}

function targetFor(input: ApplyStageTransitionInput): {
  stageId: string;
  state: string;
  labels: string[];
} {
  const retained = metadataLabels(input.issue.labels, input.labels);
  const base = [input.labels.enrollment, ...retained];
  const result = input.result;
  if (result.kind === "advance") {
    if (result.nextStageId) {
      return {
        stageId: result.nextStageId,
        state: "awaiting-source",
        labels: [
          ...base,
          input.labels.stageTemplate.replace("{stage}", result.nextStageId),
        ],
      };
    }
    const done = input.labels.states.done;
    if (!done) throw new Error('labels.states must define logical state "done"');
    return {
      stageId: result.stageId,
      state: "done",
      labels: [
        ...base,
        input.labels.stageTemplate.replace("{stage}", result.stageId),
        done,
      ],
    };
  }
  if (result.kind === "correction") {
    return {
      stageId: result.targetStageId,
      state: "awaiting-source",
      labels: [
        ...base,
        input.labels.stageTemplate.replace("{stage}", result.targetStageId),
      ],
    };
  }
  const stateLabel = input.labels.states[result.state];
  if (!stateLabel) {
    throw new Error(`no source label is configured for state "${result.state}"`);
  }
  return {
    stageId: result.stageId,
    state: result.state,
    labels: [
      ...base,
      input.labels.stageTemplate.replace("{stage}", result.stageId),
      stateLabel,
    ],
  };
}

/**
 * A legacy producer may stop with any failure status it returns (e.g. `changes-requested` at
 * implementation), not only states that have a source label. Such a stop becomes `blocked`, keeping
 * the original status in the reason, rather than failing the transition and retrying it forever.
 */
function stopWithConfiguredState(input: ApplyStageTransitionInput): ApplyStageTransitionInput {
  const result = input.result;
  if (result.kind !== "stopped" || input.labels.states[result.state] || !input.labels.states.blocked) return input;
  return {
    ...input,
    result: {
      ...result,
      state: "blocked",
      reason: `Stopped as ${result.state} (no label is configured for that state): ${result.reason}`,
    },
  };
}

/** Apply the externally visible checkpoint once, then wait for reconciliation. */
export async function applyStageTransition(
  input: ApplyStageTransitionInput,
): Promise<{ labels: string[] }> {
  input = stopWithConfiguredState(input);
  const target = targetFor(input);
  const stageResult = input.result.result?.stageResult;
  const detail = input.result.kind === "advance"
    ? {
        reason: stageResult?.summary ?? `Completed ${input.result.stageId}`,
        requiredFixes: [],
        resultStatus: stageResult?.status ?? null,
        actor: input.actor ?? null,
      }
    : {
        reason: input.result.reason,
        requiredFixes: input.result.requiredFixes,
        resultStatus:
          stageResult?.status ??
          (input.result.kind === "stopped" ? input.result.state : "changes-requested"),
        actor: input.actor ?? null,
        ...(input.result.kind === "stopped"
          ? { sourceSnapshot: { title: input.issue.title, body: input.issue.body } }
          : {}),
      };
  const labels = [...new Set(target.labels)].sort((left, right) =>
    left.localeCompare(right),
  );
  const mutation = input.store.beginSourceMutation({
    idempotencyKey: `transition:${input.transitionId}`,
    source: input.sourceName,
    operation: "issue.labels.replace",
    request: {
      issueId: input.issue.id,
      issueNumber: input.issue.sourceNumber,
      labels,
    },
  });
  input.store.beginStageTransition({
    id: input.transitionId,
    issueId: input.issue.id,
    fromStage: input.result.stageId,
    toStage: target.stageId,
    kind: input.result.kind,
    sourceMutationId: mutation.id,
    detail,
  });
  if (mutation.status !== "succeeded") {
    try {
      await input.source.replaceConveyorLabels(
        input.address,
        input.issue.sourceNumber,
        labels,
        [input.labels.metadata.noSplit],
      );
      input.store.completeSourceMutation(mutation.id, { labels });
    } catch (error) {
      // A repository pause is a durable wait, not a failed source mutation.
      // Leaving both records pending lets the same transition resume after the
      // pause without losing its idempotency key or re-running the stage.
      if (error instanceof RepositoryPausedError) throw error;
      input.store.failSourceMutation(
        mutation.id,
        error instanceof Error ? error.message : String(error),
      );
      input.store.failStageTransition(input.transitionId);
      throw error;
    }
  }
  // The source transition succeeded: close the todo list out together with the local advance.
  input.store.sqlite().transaction(() => {
    input.store.completeStageTransition(input.transitionId);
    if (input.result.kind === "advance" && input.result.stageId === TODO_OWNING_STAGE) {
      new ItemTodos(input.store.sqlite()).closeOut(input.issue.id);
    }
    input.store.setStageState({
      issueId: input.issue.id,
      stageId: target.stageId,
      status: target.state,
      feedbackCycle:
        input.result.kind === "correction" ? 0 : input.result.feedbackCycles,
      configHash: input.configHash,
    });
  })();
  return { labels };
}

/** Remove Conveyor's controls from an issue that closed without its current change being merged. */
export async function applyClosedItemOffboarding(
  input: ApplyClosedItemOffboardingInput,
): Promise<void> {
  const mutation = input.store.beginSourceMutation({
    idempotencyKey: input.transitionId,
    source: input.sourceName,
    operation: "issue.labels.replace",
    request: { issueId: input.issue.id, issueNumber: input.issue.sourceNumber, labels: [] },
  });
  input.store.beginStageTransition({
    id: input.transitionId,
    issueId: input.issue.id,
    fromStage: input.issue.projectedStage,
    toStage: null,
    kind: "offboarded",
    sourceMutationId: mutation.id,
    detail: {
      reason: "closed without a merged change",
      requiredFixes: [],
      resultStatus: null,
      actor: { name: "Conveyor", title: "Orchestrator" },
    },
  });
  if (mutation.status !== "succeeded") {
    try {
      // No preserve list: closure cleanup intentionally removes every Conveyor control label.
      await input.source.replaceConveyorLabels(input.address, input.issue.sourceNumber, []);
      input.store.completeSourceMutation(mutation.id, { labels: [] });
    } catch (error) {
      if (error instanceof RepositoryPausedError) throw error;
      input.store.failSourceMutation(mutation.id, error instanceof Error ? error.message : String(error));
      input.store.failStageTransition(input.transitionId);
      throw error;
    }
  }
  input.store.sqlite().transaction(() => {
    input.store.completeStageTransition(input.transitionId);
    input.store.setIssueProjection(input.issue.id, { stage: null, state: "offboarded", warning: null });
    input.store.endActiveEnrollment(input.issue.id, "offboarded");
  })();
}

/** Move a non-runnable roll-up parent with the earliest unfinished child frontier. */
export async function applyRollupTransition(
  input: ApplyRollupTransitionInput,
): Promise<boolean> {
  // A done label on a parent can be stale when a descendant resumes post-merge
  // work. Other configured state labels still stop a roll-up from overwriting
  // an operator-visible state.
  const stopLabels = Object.entries(input.labels.states).flatMap(([state, label]) =>
    state === "done" ? [] : [label],
  );
  if (input.issue.labels.some((label) => stopLabels.includes(label))) return false;
  // Closeness is earned only after every descendant is complete, so a repair
  // from a stale done parent must remove it with the stage transition.
  const retained = metadataLabels(input.issue.labels, input.labels)
    .filter((label) => label !== input.labels.metadata.closable);
  const labels = [...new Set([
    input.labels.enrollment,
    ...retained,
    input.labels.stageTemplate.replace("{stage}", input.targetStageId),
  ])].sort((left, right) => left.localeCompare(right));
  const mutation = input.store.beginSourceMutation({
    idempotencyKey: `transition:${input.transitionId}`,
    source: input.sourceName,
    operation: "issue.labels.replace",
    request: {
      issueId: input.issue.id,
      issueNumber: input.issue.sourceNumber,
      labels,
    },
  });
  input.store.beginStageTransition({
    id: input.transitionId,
    issueId: input.issue.id,
    fromStage: input.issue.projectedStage,
    toStage: input.targetStageId,
    kind: "rollup",
    sourceMutationId: mutation.id,
    detail: {
      reason: input.reason,
      requiredFixes: [],
      resultStatus: null,
      actor: { name: "Conveyor", title: "Orchestrator" },
    },
  });
  if (mutation.status !== "succeeded") {
    try {
      await input.source.replaceConveyorLabels(
        input.address,
        input.issue.sourceNumber,
        labels,
        [input.labels.metadata.noSplit],
      );
      input.store.completeSourceMutation(mutation.id, { labels });
    } catch (error) {
      // The roll-up follows the same pause boundary as ordinary stages.
      if (error instanceof RepositoryPausedError) throw error;
      input.store.failSourceMutation(
        mutation.id,
        error instanceof Error ? error.message : String(error),
      );
      input.store.failStageTransition(input.transitionId);
      throw error;
    }
  }
  input.store.completeStageTransition(input.transitionId);
  input.store.setStageState({
    issueId: input.issue.id,
    stageId: input.targetStageId,
    status: "awaiting-source",
    feedbackCycle: 0,
    configHash: input.configHash,
  });
  return true;
}
