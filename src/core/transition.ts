import type { StoredIssue, ConveyorStore } from "../db/store";
import type { StageExecutionResult } from "./pipeline";
import type { LabelConfiguration } from "./issue-state";

export interface TransitionSource {
  replaceConveyorLabels(
    address: string,
    issueNumber: number,
    labels: readonly string[],
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

/** Apply the externally visible checkpoint once, then wait for reconciliation. */
export async function applyStageTransition(
  input: ApplyStageTransitionInput,
): Promise<void> {
  const target = targetFor(input);
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
  if (mutation.status !== "succeeded") {
    try {
      await input.source.replaceConveyorLabels(
        input.address,
        input.issue.sourceNumber,
        labels,
      );
      input.store.completeSourceMutation(mutation.id, { labels });
    } catch (error) {
      input.store.failSourceMutation(
        mutation.id,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }
  input.store.setStageState({
    issueId: input.issue.id,
    stageId: target.stageId,
    status: target.state,
    feedbackCycle:
      input.result.kind === "correction" ? 0 : input.result.feedbackCycles,
    configHash: input.configHash,
  });
}
