export type IssueTone = "active" | "success" | "warning" | "danger" | "muted";

export interface IssueRelationViewModel {
  id: string;
  repository: string;
  number: number;
  title: string;
  url: string | null;
  satisfied: boolean;
}

export interface IssueWaitingViewModel {
  reason: string;
  since: string;
  nextCheckAt: string | null;
  deadline: string | null;
}

/** A server-ready issue card with lightweight hierarchy references. */
export interface IssueCardViewModel {
  id: string;
  repository: string;
  number: number;
  title: string;
  url: string | null;
  state: string;
  labels: readonly string[];
  acceptanceCriteria: readonly string[];
  activity: string | null;
  reason: string | null;
  cost: string | null;
  duration: string | null;
  stateChangedAt: string | null;
  waiting: IssueWaitingViewModel | null;
  blocked: boolean;
  inconsistent: boolean;
  closable: boolean;
  tone: IssueTone;
  parent: IssueRelationViewModel | null;
  children: readonly IssueRelationViewModel[];
  dependencies: readonly IssueRelationViewModel[];
  working: boolean;
}

export interface ActiveRunViewModel {
  id: string;
  issueId: string;
  repository: string;
  issueNumber: number;
  issueTitle: string;
  stageId: string;
  kind: string;
  startedAt: string;
}

export interface IssueRunEventViewModel {
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface IssueRunViewModel {
  id: string;
  stageId: string;
  attempt: number;
  kind: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  result: unknown | null;
  events: readonly IssueRunEventViewModel[];
  nextEventBefore: number | null;
}

export interface IssueActivityViewModel {
  issueId: string;
  runs: readonly IssueRunViewModel[];
  nextRunBefore: string | null;
}

export interface IssueRunEventsViewModel {
  issueId: string;
  runId: string;
  events: readonly IssueRunEventViewModel[];
  nextEventBefore: number | null;
}

export interface SystemStatusViewModel {
  memory: { usedBytes: number; totalBytes: number; processBytes: number };
  disk: { usedBytes: number; totalBytes: number; availableBytes: number };
  uptimeSeconds: number;
}

export interface IssueConversationMessageViewModel {
  id: number;
  stageId: string | null;
  actorType: string;
  actorId: string;
  actorName: string;
  actorTitle: string | null;
  message: string;
  createdAt: string;
}

export interface IssueConversationViewModel {
  issueId: string;
  messages: readonly IssueConversationMessageViewModel[];
}

export interface IssueJourneyTransitionViewModel {
  id: string;
  fromStage: string | null;
  toStage: string | null;
  kind: string;
  status: string;
  resultStatus: string | null;
  reason: string | null;
  requiredFixes: readonly string[];
  actor: string;
  createdAt: string;
  completedAt: string | null;
}

export interface IssueJourneyViewModel {
  issueId: string;
  now: {
    stage: string | null;
    state: string;
    reason: string | null;
    since: string | null;
  };
  transitions: readonly IssueJourneyTransitionViewModel[];
}

export interface StageActorViewModel {
  type: "agent" | "script";
  name: string;
  title: string | null;
}

export interface StageColumnViewModel {
  id: string;
  name: string;
  actors: readonly StageActorViewModel[];
  cost: string | null;
  totalIssues: number;
  page: number;
  totalPages: number;
  issues: readonly IssueCardViewModel[];
}

export interface DashboardPageSelection {
  view: DashboardView;
  column: string | null;
  page: number;
  doneLimit: number;
  runId: string | null;
  issueId: string | null;
}

export type DashboardView = "board" | "attention" | "agent";

export interface SteeringEventViewModel {
  sequence: number;
  type: string;
  text: string;
  createdAt: string;
}

export interface SteeringRunViewModel {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  events: readonly SteeringEventViewModel[];
}

export interface SteeringViewModel {
  enabled: boolean;
  agent: string | null;
  selected: SteeringRunViewModel | null;
  recent: readonly { id: string; status: string; startedAt: string }[];
}

export interface QuestionViewModel {
  id: string;
  issueId: string;
  issueNumber: number;
  issueTitle: string;
  prompt: string;
  reason: string;
  options: readonly { id: string; label: string }[];
  allowFreeText: boolean;
}

export interface DashboardViewModel {
  title: string;
  project: string;
  totalUsage: string;
  updatedAt: string;
  revision: string;
  view: DashboardView;
  counts: { board: number; attention: number };
  activeWork: {
    runnerCount: number;
    runnerCapacity: number;
    runs: readonly ActiveRunViewModel[];
  };
  stages: readonly StageColumnViewModel[];
  backlog: readonly IssueCardViewModel[];
  done: StageColumnViewModel;
  attention: StageColumnViewModel;
  questions: readonly QuestionViewModel[];
  needsYou: readonly IssueCardViewModel[];
  systemWarnings: readonly string[];
  steering: SteeringViewModel;
  selectedIssue: IssueCardViewModel | null;
  /** Configured agents, each linking to its read-only profile page. */
  agents?: readonly AgentSummaryViewModel[];
  csrfToken: string;
}

export interface AgentSummaryViewModel {
  id: string;
  name: string;
  title: string;
}

export interface AgentUsageViewModel {
  /** Null for a role outside any pipeline, such as dashboard steering. */
  pipeline: string | null;
  stage: string | null;
  role: string;
}

export interface AgentProfileViewModel extends AgentSummaryViewModel {
  harness: string;
  model: string | null;
  effort: string | null;
  access: string;
  usage: readonly AgentUsageViewModel[];
  /** Granted MCP tool tasks grouped by task group, sorted. */
  tasks: ReadonlyArray<{ group: string; tasks: readonly string[] }>;
  /** Instruction text, or null when the file could not be read. */
  instructions: string | null;
}
