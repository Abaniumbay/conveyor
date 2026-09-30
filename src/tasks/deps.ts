// The dependencies the engine hands to non-check tasks of native stages. Each task group
// extends this interface with the fields it needs; the IssueExecutor builds one value per item.

import type { ConveyorConfig } from "../config/load";
import type { ConveyorStore } from "../db/store";
import type { GitHubAdapter } from "../source/github/adapter";
import type { GitOps } from "../workspace/git";
import type { WorkspaceLifecycleManager } from "../workspace/lifecycle";

export interface TaskDeps {
  store: ConveyorStore;
  config: ConveyorConfig;
  /** The source adapter methods the item group uses. */
  items: Pick<
    GitHubAdapter,
    | "getIssue"
    | "addComment"
    | "updateManagedSection"
    | "managedRevision"
    | "setParent"
    | "setDependencies"
    | "replaceManagedProjectLabels"
    | "createChildIssue"
  >;
  repository: { id: string; address: string; folder: string; baseBranch: string };
  issueId: string;
  sourceGuidance: string;
  /** The git operations the workspace group uses. */
  git: GitOps;
  /** Creates and removes worktrees. */
  workspaces: WorkspaceLifecycleManager;
}
