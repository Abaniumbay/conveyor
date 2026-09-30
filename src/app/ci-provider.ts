/** Provider-neutral CI contract used by the gate and delivery tools. */
export type CiRunState = "queued" | "running" | "passed" | "failed" | "cancelled" | "skipped";

export interface CiRun {
  id: string;
  name: string;
  url: string | null;
  state: CiRunState;
  canRerun: boolean;
  hasLog: boolean;
}

export interface CiChange {
  repository: string;
  changeId: string;
  url: string;
}

export interface CiProvider {
  start(change: CiChange, commit: string, retryWindowMs: number, now: number): Promise<string[]>;
  list(change: CiChange, commit: string): Promise<CiRun[]>;
  rerun(change: CiChange, runId: string): Promise<void>;
  log(change: CiChange, runId: string, lines?: number): Promise<string>;
}

export function isCiRunState(value: unknown): value is CiRunState {
  return value === "queued" || value === "running" || value === "passed" || value === "failed" || value === "cancelled" || value === "skipped";
}
