/** Provider-neutral CI contract used by the gate and delivery tools. */
export type CiRunState = "queued" | "running" | "passed" | "failed" | "cancelled" | "skipped";

export interface CiRun {
  id: string;
  name: string;
  url: string | null;
  state: CiRunState;
  canRerun: boolean;
  hasLog: boolean;
  /** GitHub proved this failed check's job never reached a runner or an executable step. */
  neverStarted?: { annotation: string | null };
  /** When the provider started / finished the run; absent or null when it did not say. */
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface CiChange {
  repository: string;
  changeId: string;
  url: string;
}

/** A JUnit XML file obtained from an artifact belonging to this change's commit. */
export interface CiTestReport {
  runId: string;
  artifactId: string;
  path: string;
  content: string;
  /** A completed artifact was found but could not be read as a report. */
  error?: string;
}

export interface CiTestReportLocator {
  artifact: string;
  path: string;
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
  /** Reports are optional so non-GitHub and older providers retain the source-link fallback. */
  reports?(change: CiChange, commit: string, runs: readonly CiRun[], locator: CiTestReportLocator): Promise<CiTestReport[]>;
}

export function isCiRunState(value: unknown): value is CiRunState {
  return value === "queued" || value === "running" || value === "passed" || value === "failed" || value === "cancelled" || value === "skipped";
}
