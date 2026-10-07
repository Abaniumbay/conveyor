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
    | "setTitle"
    | "listIssueTypes"
    | "listIssueFields"
    | "getIssueFieldValues"
    | "setIssueType"
    | "setIssueFieldValues"
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
    /** Advisory mode: starts the durable watch for a head (absent when no watch store is wired). */
    watchAdvisory?: (input: { itemId: string; headSha: string; stage: string; changeId: string; changeUrl: string }) => void | Promise<void>;
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
  /**
   * Narrow system-level operations made available only to an active steering run.  Item-scoped
   * agents never receive this facade; the dispatcher also rejects these tools for item grants.
   */
  operator?: {
    board: () => unknown;
    itemHistory: (input: {
      itemId: string;
      beforeRunId?: string;
      eventRunId?: string;
      beforeEventSequence?: number;
      runLimit: number;
      eventLimit: number;
    }) => unknown | Promise<unknown>;
    retry: (itemId: string, note: string) => Promise<{ status: "started" | "queued"; stageId: string }>;
    moveBacklog: (input: { itemId: string; position: "up" | "down" | "before" | "end"; beforeItemId?: string }) => unknown;
  };
}
