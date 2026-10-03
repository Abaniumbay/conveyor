export interface ChangeRequest {
  id: string;
  number: number;
  url: string;
  state: "open" | "closed" | "merged" | string;
  headSha: string;
  draft: boolean;
  mergeable: boolean | null;
  mergedAt?: string | null;
  /** The change request's description (Markdown); empty when it has none. */
  body?: string;
}

export interface ChangeDelivery {
  change: ChangeRequest;
  checks: Array<{
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    url: string | null;
    startedAt: string | null;
    completedAt: string | null;
  }>;
  /** GitHub compatibility projection retained while consumers migrate to `change`. */
  pullRequest?: {
    number: number;
    url: string;
    state: string;
    merged: boolean;
    mergedAt: string | null;
    mergeCommitSha: string | null;
    draft: boolean;
    mergeState: string | null;
    headBranch: string;
    headSha: string;
    baseBranch: string;
  };
}

export interface ChangeReference {
  id: string;
  number: number;
  url: string;
  state: string;
}

export type BranchPushResult =
  | { pushed: true }
  | { pushed: false; status: "changes-requested"; reason: string };

/** A review artifact of the code host's native review (a thread or a changes-requested review), as a finding source. */
export interface ReviewArtifact {
  /** Stable key of the artifact on the host; dedupes imports. */
  providerKey: string;
  author: string;
  body: string;
  url: string;
  path: string | null;
  line: number | null;
  resolved: boolean;
}

export interface CodeHost {
  /** Pushes the workspace branch; with `base`, first brings it up to date with that base branch. */
  pushBranch(input: {
    address: string;
    workspace: { path: string; branch: string };
    base?: string;
  }): Promise<BranchPushResult>;
  ensureChange(input: {
    address: string;
    issueNumber: number;
    branch: string;
    base: string;
    title: string;
    closes: boolean;
  }): Promise<ChangeRequest>;
  getChange(input: { address: string; id: string }): Promise<ChangeRequest>;
  mergeChange(input: {
    address: string;
    id: string;
    method: "squash";
    /** Only squash this head: the host refuses when the change's head has moved. */
    expectedHeadSha?: string;
  }): Promise<{ merged: boolean; sha?: string; headMoved?: boolean }>;
  /** Writes the criteria checklist into the change's description as a Conveyor-managed section; human text is kept. */
  setChangeChecklist(input: { address: string; id: string; markdown: string }): Promise<void>;
  getChangeDelivery(input: {
    address: string;
    id: string;
  }): Promise<ChangeDelivery>;
  /**
   * Projects a finding onto the change: an inline review comment at path/line of `headSha` when
   * the host accepts that position, otherwise a managed change comment carrying the finding id.
   * `projection` is an opaque reference for `resolveFindingProjection`.
   */
  createFinding(input: {
    address: string;
    id: string;
    findingId: string;
    body: string;
    headSha: string;
    path?: string;
    line?: number;
  }): Promise<{ url: string; projection: string }>;
  /**
   * Marks a finding's projection resolved: `message` as a reply on an inline comment (whose thread is
   * then resolved) or as the heading of a managed comment, plus a thumbs up (fixed) or down (invalid).
   */
  resolveFindingProjection(input: {
    address: string;
    id: string;
    findingId: string;
    projection: string;
    body: string;
    actor: string;
    verdict: FindingVerdict;
    message: string;
  }): Promise<void>;
  /**
   * Answers and resolves a finding imported from the native review (`providerKey` from
   * `listReviewArtifacts`): `message` as a reply, a thumbs up or down, and the thread resolved.
   * Throws when the thread cannot be resolved, since an unresolved thread reopens the finding.
   */
  resolveNativeFinding(input: {
    address: string;
    id: string;
    providerKey: string;
    verdict: FindingVerdict;
    message: string;
  }): Promise<void>;
  /**
   * Deletes a branch on the host unless an open change still uses it. "absent" when it is already
   * gone, "kept" when an open change keeps it.
   */
  deleteBranch(input: { address: string; branch: string }): Promise<"deleted" | "absent" | "kept">;
  /** Human review artifacts of the change's native review; Conveyor's own comments and bots are excluded. */
  listReviewArtifacts(input: { address: string; id: string }): Promise<ReviewArtifact[]>;
}

/** How an agent closed a finding: the problem is fixed, or the finding is invalid (wrong, not applicable or already satisfied). */
export type FindingVerdict = "fixed" | "invalid";
