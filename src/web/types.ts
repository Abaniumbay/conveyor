/** A server-ready issue card. Child issues are rendered beneath their parent. */
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
  children: readonly IssueCardViewModel[];
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
  column: string | null;
  page: number;
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
  stages: readonly StageColumnViewModel[];
  backlog: readonly IssueCardViewModel[];
  questions: readonly QuestionViewModel[];
  systemWarnings: readonly string[];
  csrfToken: string;
}
