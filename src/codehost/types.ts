export interface ChangeRequest {
  id: string;
  number: number;
  url: string;
  state: "open" | "closed" | "merged" | string;
  headSha: string;
  draft: boolean;
  mergeable: boolean | null;
  mergedAt?: string | null;
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

export interface CodeHost {
  pushBranch(input: {
    address: string;
    workspace: { path: string; branch: string };
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
  }): Promise<{ merged: boolean; sha?: string }>;
  getChangeDelivery(input: {
    address: string;
    id: string;
  }): Promise<ChangeDelivery>;
}
