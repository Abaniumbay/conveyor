export interface LabelConfiguration {
  enrollment: string;
  stageTemplate: string;
  states: Record<string, string>;
  metadata: {
    closable: string;
    orderTemplate: string;
  };
}

export type IssueMode =
  | "offboarded"
  | "paused"
  | "closed"
  | "stopped"
  | "inconsistent"
  | "active";

export interface EvaluatedIssueState {
  mode: IssueMode;
  visible: boolean;
  eligible: boolean;
  stage: string | null;
  state: string | null;
  warnings: string[];
}

export interface IssueStateInput {
  sourceState: "open" | "closed" | string;
  sourceLabels: readonly string[];
  labels: LabelConfiguration;
  stages: readonly string[];
  expectedPostMergeClosure: boolean;
}

function templatePattern(template: string, token: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(`\\{${token}\\}`, "(.+)")}$`);
}

export function evaluateIssueState(input: IssueStateInput): EvaluatedIssueState {
  const sourceLabels = new Set(input.sourceLabels);
  const relevantLabels = input.sourceLabels.filter(
    (label) =>
      label === input.labels.enrollment ||
      label.startsWith(`${input.labels.enrollment}:`),
  );

  if (relevantLabels.length === 0) {
    return {
      mode: "offboarded",
      visible: false,
      eligible: false,
      stage: null,
      state: null,
      warnings: [],
    };
  }

  const stageLabels = new Map(
    input.stages.map((stage) => [
      input.labels.stageTemplate.replace("{stage}", stage),
      stage,
    ]),
  );
  const selectedStages = input.sourceLabels.flatMap((label) => {
    const stage = stageLabels.get(label);
    return stage ? [stage] : [];
  });
  const selectedStates = Object.entries(input.labels.states).flatMap(
    ([state, label]) => (sourceLabels.has(label) ? [state] : []),
  );
  const warnings: string[] = [];

  if (selectedStages.length > 1) {
    warnings.push(`multiple stage labels are present: ${selectedStages.join(", ")}`);
  }
  if (selectedStates.length > 1) {
    warnings.push(`multiple exclusive state labels are present: ${selectedStates.join(", ")}`);
  }

  const knownControlLabels = new Set([
    input.labels.enrollment,
    ...stageLabels.keys(),
    ...Object.values(input.labels.states),
    input.labels.metadata.closable,
  ]);
  const orderPattern = templatePattern(input.labels.metadata.orderTemplate, "number");
  const stagePattern = templatePattern(input.labels.stageTemplate, "stage");
  const unknownStageLabels = relevantLabels.filter(
    (label) =>
      !knownControlLabels.has(label) &&
      !orderPattern.test(label) &&
      stagePattern.test(label),
  );
  if (unknownStageLabels.length > 0) {
    warnings.push(`unknown stage label(s): ${unknownStageLabels.join(", ")}`);
  }

  const stage = selectedStages[0] ?? null;
  const state = selectedStates[0] ?? null;
  const hasBaseLabel = sourceLabels.has(input.labels.enrollment);

  if (!hasBaseLabel) {
    return {
      mode: "paused",
      visible: true,
      eligible: false,
      stage,
      state,
      warnings,
    };
  }

  if (warnings.length > 0) {
    return {
      mode: "inconsistent",
      visible: true,
      eligible: false,
      stage,
      state,
      warnings,
    };
  }

  if (input.sourceState === "closed" && !input.expectedPostMergeClosure) {
    return {
      mode: "closed",
      visible: true,
      eligible: false,
      stage,
      state,
      warnings: ["issue was closed before a correlated Conveyor PR merge"],
    };
  }

  if (state) {
    return {
      mode: "stopped",
      visible: true,
      eligible: false,
      stage,
      state,
      warnings,
    };
  }

  return {
    mode: "active",
    visible: true,
    eligible: true,
    stage: stage ?? input.stages[0] ?? null,
    state: null,
    warnings,
  };
}
