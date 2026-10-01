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
  input.store.upsertPullRequest({
    issueId: input.issue.id, id: change.id, number: change.number, url: change.url, state: change.state,
  });
  return { pushed: true, change };
}
