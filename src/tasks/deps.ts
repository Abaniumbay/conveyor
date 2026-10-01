// The dependencies the engine hands to non-check tasks of native stages. Each task group
// extends this interface with the fields it needs; the IssueExecutor builds one value per item.

import type { CodeHost } from "../codehost/types";
import type { ConveyorConfig } from "../config/load";
import type { ConveyorStore } from "../db/store";
import type { GitHubAdapter } from "../source/github/adapter";
import type { GitOps } from "../workspace/git";
import type { WorkspaceLifecycleManager } from "../workspace/lifecycle";
import type { RuntimeDeliveryState, ScopedMcpFactory } from "../app/runtime";
import type { Harness } from "../harness/types";
import type { CiProvider } from "../app/ci-provider";
import type { AgentActor } from "./agent-support";

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
  /** The repository's code host (the change group); null when none is configured. */
  codeHost?: CodeHost | null;
  /** The CI provider (the ci group); resolved lazily so repositories with CI disabled never need one. */
  ci?: {
    provider: () => CiProvider;
    /** Advisory mode: starts the durable watch for a head (until the watch exists this is absent). */
    watchAdvisory?: (input: { itemId: string; headSha: string }) => void | Promise<void>;
  };
  /** Posts a conversation message for a stage (the CI start announcement). */
  notify?: (message: string, stageId: string) => void | Promise<void>;
  /** The wall clock; tests inject a fake. */
  clock?: () => Date;
  /** Interrupts a running script (the script group passes it to the process). */
  signal?: AbortSignal;
  /** Leases the run-scoped MCP endpoint an agent talks to (the agent group). */
  mcp?: ScopedMcpFactory;
  /** Agent harnesses by runner type (the agent group). */
  harnesses?: Record<string, Harness>;
  /** The delivery state handed to a run's MCP context. */
  delivery?: () => Promise<RuntimeDeliveryState>;
  /** Set for agent tool calls: the run the call belongs to and who is calling. */
  run?: { id: string; actor: AgentActor | null };
}
