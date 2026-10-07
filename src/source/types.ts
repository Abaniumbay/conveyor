export interface SourceIssue {
  id: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason?: string | null;
  labels: string[];
  /** The issue type GitHub reports, when the owner defines types; null when none is set. */
  type?: string | null;
  updatedAt: string;
}

export interface PullRequestReference {
  number: number;
  url: string;
  state: string;
}

export interface IssueSourceAdapter {
  listIssues(address: string): Promise<SourceIssue[]>;
  getIssue(address: string, issueNumber: number): Promise<SourceIssue>;
}
