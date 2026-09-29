export type IssueTone = "active" | "success" | "warning" | "danger" | "muted";

export interface IssueRelationViewModel {
  number: number;
  title: string;
  url: string | null;
}

/** A server-ready issue card with lightweight hierarchy references. */
export interface IssueCardViewModel {
  id: string;
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
}

export interface IssueActivityViewModel {
  issueId: string;
  runs: readonly IssueRunViewModel[];
}

export interface StageColumnViewModel {
  id: string;
  name: string;
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
  issueNumber: number;
  prompt: string;
  reason: string;
  options: readonly { id: string; label: string }[];
  allowFreeText: boolean;
}

export interface DashboardViewModel {
  title: string;
  project: string;
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
  systemWarnings: readonly string[];
  steering: SteeringViewModel;
  csrfToken: string;
}
