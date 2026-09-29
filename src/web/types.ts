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
  name: string;
  issues: readonly IssueCardViewModel[];
}

export interface DashboardViewModel {
  title: string;
  project: string;
  updatedAt: string;
  stages: readonly StageColumnViewModel[];
  backlog: readonly IssueCardViewModel[];
}
