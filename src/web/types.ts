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
}

export type DashboardView = "board" | "backlog" | "attention";

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
  view: DashboardView;
  counts: { board: number; backlog: number; attention: number };
  stages: readonly StageColumnViewModel[];
  backlog: readonly IssueCardViewModel[];
  attention: StageColumnViewModel;
  questions: readonly QuestionViewModel[];
  systemWarnings: readonly string[];
  csrfToken: string;
}
