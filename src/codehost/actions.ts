import type { ConveyorStore } from "../db/store";
import type { ChangeRequest, CodeHost } from "./types";

export type ChangeAction = "ensure" | "merge";

/** Normalize the provider-neutral action names and their legacy PR aliases.
 * @deprecated `pullRequest.ensure` and `pullRequest.squashMerge` remain accepted for existing pipelines.
 */
export function changeAction(name: string): ChangeAction | null {
  if (name === "change.ensure" || name === "pullRequest.ensure") return "ensure";
  if (name === "change.merge" || name === "pullRequest.squashMerge") return "merge";
  return null;
}

export type EnsuredChange =
  | { pushed: false; status: "changes-requested"; reason: string }
  | { pushed: true; change: ChangeRequest };

type ChangeStore = Pick<ConveyorStore, "upsertPullRequest">;

function recordChange(store: ChangeStore, issueId: string, change: ChangeRequest): void {
  store.upsertPullRequest({
    issueId, id: change.id, number: change.number, url: change.url, state: change.state,
    ...(change.mergedAt === undefined ? {} : { mergedAt: change.mergedAt }),
  });
}

/** Records an already-open change before later stages read the item's change state. */
export async function linkExistingChange(input: {
  codeHost: Pick<CodeHost, "findOpenChange">;
  store: ChangeStore & Pick<ConveyorStore, "getCurrentPullRequest">;
  address: string;
  issueId: string;
  branch: string;
}): Promise<ChangeRequest | null> {
  if (input.store.getCurrentPullRequest(input.issueId) || !input.codeHost.findOpenChange) return null;
  const change = await input.codeHost.findOpenChange({ address: input.address, branch: input.branch });
  if (!change) return null;
  recordChange(input.store, input.issueId, change);
  return change;
}

/**
 * Replaces a pre-merge change only after its provider record confirms it was closed without merge.
 * The source mutation makes a crash after opening the replacement safe to retry.
 */
export async function recoverClosedChange(input: {
  codeHost: Pick<CodeHost, "findOpenChange" | "getChange" | "ensureChange">;
  store: ChangeStore & Pick<ConveyorStore, "getCurrentPullRequest" | "beginSourceMutation" | "completeSourceMutation" | "failSourceMutation">;
  source: string;
  address: string;
  issue: { id: string; sourceNumber: number; title: string };
  workspace: { branch: string };
  base: string;
  closes: boolean;
}): Promise<ChangeRequest | null> {
  const stored = input.store.getCurrentPullRequest(input.issue.id);
  if (!stored) {
    return linkExistingChange({
      codeHost: input.codeHost, store: input.store, address: input.address,
      issueId: input.issue.id, branch: input.workspace.branch,
    });
  }

  const current = await input.codeHost.getChange({ address: input.address, id: stored.id });
  if (current.state !== "closed") {
    recordChange(input.store, input.issue.id, current);
    return current;
  }

  const open = input.codeHost.findOpenChange
    ? await input.codeHost.findOpenChange({ address: input.address, branch: input.workspace.branch })
    : null;
  if (open) {
    recordChange(input.store, input.issue.id, open);
    return open;
  }

  const mutation = input.store.beginSourceMutation({
    idempotencyKey: `change-recovery:${input.issue.id}:${stored.id}`,
    source: input.source,
    operation: "change.recover",
    request: { issueId: input.issue.id, changeId: stored.id, branch: input.workspace.branch },
  });
  try {
    const replacement = await input.codeHost.ensureChange({
      address: input.address,
      issueNumber: input.issue.sourceNumber,
      branch: input.workspace.branch,
      base: input.base,
      title: input.issue.title,
      closes: input.closes,
    });
    if (replacement.state === "closed") {
      throw new Error(`replacement change ${replacement.id} is closed without merge`);
    }
    recordChange(input.store, input.issue.id, replacement);
    input.store.completeSourceMutation(mutation.id, replacement);
    return replacement;
  } catch (error) {
    input.store.failSourceMutation(mutation.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/**
 * Pushes the workspace branch, ensures the change request for it and stores it for the item.
 * Shared by the `change.ensure` task and the legacy source actions.
 */
export async function pushAndEnsureChange(input: {
  codeHost: CodeHost;
  store: Pick<ConveyorStore, "upsertPullRequest">;
  address: string;
  issue: { id: string; sourceNumber: number; title: string };
  workspace: { path: string; branch: string };
  base: string;
  closes: boolean;
}): Promise<EnsuredChange> {
  const pushed = await input.codeHost.pushBranch({ address: input.address, workspace: input.workspace, base: input.base });
  if (!pushed.pushed) return pushed;
  const change = await input.codeHost.ensureChange({
    address: input.address,
    issueNumber: input.issue.sourceNumber,
    branch: input.workspace.branch,
    base: input.base,
    title: input.issue.title,
    closes: input.closes,
  });
  recordChange(input.store, input.issue.id, change);
  return { pushed: true, change };
}
