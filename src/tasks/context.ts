// Task context and snapshot types. Appendix B of issue #19 is the source.

import type { RunEnvelope } from "../runner/result";

export const CONTEXT_SCHEMA_VERSION = 1;

/** Keys owned by a single load task; the engine reloads them when invalidated. */
export const SNAPSHOT_KEYS = ["item", "workspace", "change", "ci"] as const;
export type SnapshotKey = (typeof SNAPSHOT_KEYS)[number];

/** Keys the engine captures from act task results. */
export const CAPTURED_KEYS = ["agent", "script", "legacy"] as const;
export type CapturedKey = (typeof CAPTURED_KEYS)[number];

export interface RepositoryContext {
  id: string;
  address: string;
  folder: string;
  baseBranch: string;
  ciMode: "required" | "advisory" | "disabled";
  /** The repository's configured system labels (may be empty). */
  systemLabels: string[];
}

export interface ItemContext {
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  state: string;
  criteria: Array<{ id: string; text: string; manual: boolean }>;
  children: Array<{ id: string; number: number; state: string; enrolled: boolean; hasCriteria: boolean; hasChildren: boolean }>;
  dependencies: Array<{ id: string; number: number; satisfied: boolean }>;
  systemLabels: string[];
}

export interface WorkspaceContext {
  path: string | null;
  branch: string | null;
  exists: boolean;
  clean: boolean;
  ahead: number;
  behind: number;
  remoteHeadSha: string | null;
  localHeadSha: string | null;
}

export interface AgentContext {
  agentId: string;
  status: string;
  summary: string;
  reason: string | null;
  sessionId: string | null;
  runId: string;
}

export interface TaskContext {
  schemaVersion: number;
  configHash: string;
  run: RunContext;                  // engine, rewritten for each task
  repository: RepositoryContext;    // engine/config
  item: ItemContext;                // item.load only
  workspace?: WorkspaceContext;     // workspace.load only
  change?: ChangeContext;           // change.load only
  ci?: CiContext;                   // ci.load only
  agent?: AgentContext;             // engine-captured agent.run result
  script?: ScriptContext;           // engine-captured script.run results
  legacy?: RunEnvelope;             // engine-captured legacy.produce envelope
  checkpoints: GateCheckpoints;     // engine only
  engine?: EngineState;             // engine only, never readable by tasks
}

/**
 * Engine bookkeeping that must survive a restart. `stale` are snapshot keys an act
 * invalidated and no load has refreshed yet. `returns` counts cross-stage `return`
 * routes since the item last left the pipeline; the next stage to start carries it
 * in its first cursor and the maxReturns guard compares against it.
 */
export interface EngineState {
  stale: SnapshotKey[];
  returns: number;
}

export interface RunContext {
  stage: string;
  stageEpoch: number;               // fencing token; increases on every stage/state change
  attempt: number;
  maxAttempts: number;
  taskInstanceId: string;
  enteredAt: string;
  feedback: Feedback | null;
}

export interface Feedback {
  from: { stage: string; taskInstanceId: string };
  message: string;
  details?: unknown;                // bounded; large output is an artifact link
}

export interface GateCheckpoints {
  ciPassed: { sha: string; at: string; taskInstanceId: string } | null;
  reviewPassed: { sha: string; at: string; taskInstanceId: string } | null;
}

export interface ChangeContext {
  ref: { provider: string; id: string; number: number | null };
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  headSha: string;
  baseBranch: string;
  mergeable: "yes" | "no" | "unknown";
  mergeCommitSha: string | null;
  criteria: Array<{
    id: string;
    projectedChecked: boolean;       // PR rendering, not authority
    approval: null | {
      reviewer: string;
      headSha: string;
      checkedAt: string;
    };
  }>;
  findings: Array<{
    id: string;
    providerKey: string | null;       // stable key for imported native artifacts
    author: string;
    source: "agent" | "human";
    headSha: string;
    state: "open" | "resolved" | "dismissed" | "withdrawn";
    path: string | null;
    line: number | null;
    url: string;
    dismissal?: { actor: string; reason: string; at: string };
    withdrawal?: { actor: string; reason: "provider-artifact-deleted"; at: string };
  }>;
}

export interface CiContext {
  headSha: string;
  defined: boolean;
  definitionSummary: string;
  runs: Array<{
    id: string;
    name: string;
    state: "queued" | "running" | "passed" | "failed" | "cancelled" | "skipped";
    url: string | null;
    rerunnable: boolean;
    hasLog: boolean;
  }>;
}

export interface HarnessCapabilities {
  sessionResume: boolean;
}

// Added by C4 to the neutral harness input. The engine supplies these fields
// only after a parked question is answered and only to a capable harness.
export interface HarnessResumeInput {
  resumeSessionId?: string;
  answeredQuestion?: { question: string; answer: string };
}

export type ScriptRecoveryRequest =
  | { phase: "observe"; idempotencyKey: string; taskInstanceId: string }
  | { phase: "apply"; idempotencyKey: string; taskInstanceId: string };

export type ScriptRecoveryObservation =
  | { state: "already-applied"; operationId: string | null; result: unknown }
  | { state: "not-applied" }
  | { state: "indeterminate"; reason: string };

export interface ScriptContext {
  results: Record<string, {           // stable task-instance ID
    passed: boolean;
    recovery: "replay-safe" | "reconcile";
    externalOperationId: string | null;
    summary: string;
    artifactUrl: string | null;
    outputTail: string;
    finishedAt: string;
  }>;
}

// Stored separately from the materialized context; append-only except for the
// state/deadline fields of the current execution.
export interface TaskExecutionRecord {
  id: string;
  itemId: string;
  stage: string;
  stageEpoch: number;
  attempt: number;
  list: "actions" | "exit-gate";
  taskInstanceId: string;
  idempotencyKey: string;
  state: "planned" | "running" | "pending" | "completed" | "failed";
  recoveryState: "not-needed" | "observe-required" | "already-applied" | "safe-to-apply" | "indeterminate";
  startedAt: string;
  pendingSince: string | null;
  wakeAt: string | null;
  deadlineAt: string | null;
  result: unknown;
}

// Stored separately because an advisory watch intentionally outlives the
// implementation stage that started it.
export interface AdvisoryCiWatch {
  id: string;                         // unique(repositoryId, itemId, headSha)
  repositoryId: string;
  itemId: string;
  headSha: string;
  state: "active" | "superseded" | "passed" | "failed" | "timed-out";
  startedAt: string;
  wakeAt: string;
  deadlineAt: string;
  announcedAt: string | null;
  finalMessageAt: string | null;
}

export type ContextKey = keyof Omit<TaskContext, "schemaVersion" | "configHash" | "engine">;
