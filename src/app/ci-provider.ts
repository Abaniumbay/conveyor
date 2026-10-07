/** Provider-neutral CI contract used by the gate and delivery tools. */
export type CiRunState = "queued" | "running" | "passed" | "failed" | "cancelled" | "skipped";

export interface CiRun {
  id: string;
  name: string;
  url: string | null;
  state: CiRunState;
  canRerun: boolean;
  hasLog: boolean;
  /** When the provider started / finished the run; absent or null when it did not say. */
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface CiChange {
  repository: string;
  changeId: string;
  url: string;
}

/** Whether CI is defined for a commit. `provable: false` means the provider could not tell. */
export interface CiDefinition {
  defined: boolean;
  summary: string;
  provable: boolean;
}

export interface CiProvider {
  start(change: CiChange, commit: string, retryWindowMs: number, now: number): Promise<string[]>;
  list(change: CiChange, commit: string): Promise<CiRun[]>;
  rerun(change: CiChange, runId: string): Promise<void>;
  definitions(change: CiChange, commit: string): Promise<CiDefinition>;
  log(change: CiChange, runId: string, lines?: number): Promise<string>;
}

export function isCiRunState(value: unknown): value is CiRunState {
  return value === "queued" || value === "running" || value === "passed" || value === "failed" || value === "cancelled" || value === "skipped";
}
