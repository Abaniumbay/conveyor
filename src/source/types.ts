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

/** The actor GitHub attributes to a source event. A missing actor is deliberately untrusted. */
export interface SourceEventActor {
  login: string | null;
}

/** Provenance for the source events that can admit or replace agent-visible issue text. */
export interface SourceIssueProvenance {
  /** The effective current enrollment-label event, or null when the label is not currently applied. */
  enrollment: SourceEventActor | null;
  /** The last actor GitHub recorded for a title edit, if GitHub recorded one. */
  title: SourceEventActor | null;
  /** The last actor GitHub recorded for a body edit, if GitHub recorded one. */
  body: SourceEventActor | null;
}

export interface PullRequestReference {
  number: number;
  url: string;
  state: string;
}

export interface IssueSourceAdapter {
  /** Every issue of the repository, or with `since` only those updated at or after that time. */
  listIssues(address: string, options?: { since?: string }): Promise<SourceIssue[]>;
  getIssue(address: string, issueNumber: number): Promise<SourceIssue>;
  /** Read the event actors needed to decide whether enrollment and text are trusted. */
  getIssueProvenance(address: string, issueNumber: number, enrollmentLabel: string): Promise<SourceIssueProvenance>;
}
