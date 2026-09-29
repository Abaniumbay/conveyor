export interface SourceIssue {
  id: string;
  number: number;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
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
