// Per-item status indicators. An indicator is a small stored record (id, label, state, detail,
// optional link, observation time and entries) that built-in integrations produce and Conveyor
// persists; the board only reads stored records and never calls a provider while rendering. The
// model is internal. CI is the first source; PR state, deploy results or todo progress can
// produce the same record. The CI derivation shares its counted-run rules with `ci.passed`.

import type { ConveyorStore } from "../db/store";
import type { CiRun } from "./ci-provider";

export type IndicatorState = "passing" | "running" | "failed" | "unknown";

export interface IndicatorEntry {
  name: string;
  state: string;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface Indicator {
  id: string;
  label: string;
  state: IndicatorState;
  /** One line for the details view, for example "1 running · 1/2 passed". */
  detail: string;
  /** The compact figure on a board chip, for example "2/2" or "1 failed". */
  progress: string;
  url: string | null;
  observedAt: string;
  entries: IndicatorEntry[];
  /** What the observation is about (for CI the short head commit), linked to `url` of the change. */
  reference: { label: string; url: string | null } | null;
}

export interface StoredIndicator extends Indicator {
  /** The subject version the record belongs to (the change's head commit for CI). */
  headSha: string;
  changedAt: string;
}

export const CI_INDICATOR_ID = "ci";
/** How long a head without any registered run still counts as "CI is starting". */
export const CI_STARTING_MS = 120_000;

export interface CiDerivationInput {
  headSha: string;
  changeUrl: string;
  /** The provider's runs for the head, before `ignoreChecks`; null when they could not be read. */
  runs: CiRun[] | null;
  error?: string;
  ignoreChecks: readonly string[];
  /** Names of cancelled runs that were already rerun once, and the ids of those reruns. */
  reruns?: readonly string[];
  rerunIds?: readonly string[];
  /** Checks started by label that have not registered yet. */
  awaitingStart?: readonly string[];
  /** The head is new: no registered run yet is "starting", not "unknown". */
  starting: boolean;
  observedAt: string;
}

function base(input: CiDerivationInput): Pick<Indicator, "id" | "label" | "url" | "observedAt" | "reference"> {
  return {
    id: CI_INDICATOR_ID, label: "CI", url: `${input.changeUrl}/checks`, observedAt: input.observedAt,
    reference: { label: input.headSha.slice(0, 7), url: input.changeUrl },
  };
}

/** The CI indicator for one observation of a head. Counted runs follow `ci.passed`. */
export function deriveCiIndicator(input: CiDerivationInput): Indicator {
  const head = base(input);
  if (input.runs === null) {
    return { ...head, state: "unknown", detail: `CI could not be read${input.error ? `: ${input.error}` : ""}`, progress: "unreadable", entries: [] };
  }
  const ignored = new Set(input.ignoreChecks);
  const reruns = new Set(input.reruns ?? []);
  const rerunIds = new Set(input.rerunIds ?? []);
  const entries: IndicatorEntry[] = [];
  let failed = 0;
  let running = 0;
  let passed = 0;
  for (const run of input.runs) {
    if (ignored.has(run.name)) continue;
    let state: string = run.state;
    if (state === "cancelled" && rerunIds.has(run.id)) state = "running";
    if (state === "queued" || state === "running") running += 1;
    // A cancelled run that can still be rerun is rerun once: until then it is unfinished, not failed.
    else if (state === "cancelled" && run.canRerun && !reruns.has(run.name)) { running += 1; state = "running"; }
    else if (state === "passed" || state === "skipped") passed += 1;
    else failed += 1;
    entries.push({ name: run.name, state, url: run.url, startedAt: run.startedAt ?? null, completedAt: run.completedAt ?? null });
  }
  const registered = new Set(entries.filter((entry) => entry.state !== "skipped").map((entry) => entry.name));
  const awaiting = (input.awaitingStart ?? []).filter((name) => !registered.has(name) && !ignored.has(name));
  running += awaiting.length;
  const total = entries.length + awaiting.length;
  const tally = `${passed}/${total} passed`;
  if (failed > 0) return { ...head, state: "failed", detail: `${failed} failed · ${tally}`, progress: `${failed} failed`, entries };
  if (running > 0) {
    const starting = entries.length === 0;
    return { ...head, state: "running", detail: starting ? "CI is starting" : `${running} running · ${tally}`, progress: starting ? "starting" : `${running} running`, entries };
  }
  if (entries.length === 0) {
    return input.starting
      ? { ...head, state: "running", detail: "CI is starting", progress: "starting", entries }
      : { ...head, state: "unknown", detail: "No CI runs reported for this commit", progress: "no runs", entries };
  }
  return { ...head, state: "passing", detail: tally, progress: `${passed}/${total}`, entries };
}

export interface CiObservationInput {
  issueId: string;
  headSha: string;
  changeUrl: string;
  runs: CiRun[] | null;
  error?: string;
  ignoreChecks: readonly string[];
  now: Date;
  /** True when `headSha` is known to be the change's current head (it replaces an older head). */
  authoritative: boolean;
}

/** Derives and stores the item's CI indicator; false when it is older than the stored head. */
export function observeCi(store: ConveyorStore, input: CiObservationInput): boolean {
  const marks = store.executions();
  const observedAt = input.now.toISOString();
  const firstSeen = marks.markCi(input.issueId, input.headSha, "first-seen", "", observedAt).at;
  const indicator = deriveCiIndicator({
    headSha: input.headSha, changeUrl: input.changeUrl, runs: input.runs,
    ...(input.error === undefined ? {} : { error: input.error }),
    ignoreChecks: input.ignoreChecks,
    reruns: marks.ciMarks(input.issueId, input.headSha, "rerun"),
    rerunIds: marks.ciMarks(input.issueId, input.headSha, "rerun-id"),
    awaitingStart: marks.ciMarks(input.issueId, input.headSha, "started"),
    starting: input.now.getTime() - Date.parse(firstSeen) < CI_STARTING_MS,
    observedAt,
  });
  return store.saveIndicator(input.issueId, input.headSha, indicator, input.authoritative);
}

/** A new head replaces the indicator at once: its old runs are gone and CI is starting. */
export function startCiForHead(store: ConveyorStore, input: { issueId: string; headSha: string; changeUrl: string; now: Date }): boolean {
  return observeCi(store, { ...input, runs: [], ignoreChecks: [], authoritative: true });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Records an unreadable provider for the head without leaving a stale state. */
export function observeCiError(store: ConveyorStore, input: Omit<CiObservationInput, "runs" | "error"> & { error: unknown }): boolean {
  const { error, ...rest } = input;
  return observeCi(store, { ...rest, runs: null, error: errorMessage(error) });
}

// ── view model ──────────────────────────────────────────────────────────────────────────────

export interface IndicatorEntryViewModel {
  name: string;
  state: string;
  url: string | null;
  startedAt: string | null;
  /** Elapsed (running) or final duration; null when the provider gave no start time. */
  durationMs: number | null;
  /** True while the run has no completion time and is still going. */
  live: boolean;
}

export interface IndicatorViewModel {
  id: string;
  label: string;
  state: IndicatorState;
  symbol: string;
  stateWord: string;
  progress: string;
  detail: string;
  url: string | null;
  observedAt: string;
  reference: { label: string; url: string | null } | null;
  entries: readonly IndicatorEntryViewModel[];
}

const SYMBOLS: Record<IndicatorState, [string, string]> = {
  passing: ["✓", "passing"],
  running: ["●", "running"],
  failed: ["✕", "failed"],
  unknown: ["?", "unknown"],
};

/** The one shape the board card chip and the details section both render. */
export function indicatorView(indicator: Indicator, now: number): IndicatorViewModel {
  const [symbol, stateWord] = SYMBOLS[indicator.state];
  return {
    id: indicator.id, label: indicator.label, state: indicator.state, symbol, stateWord,
    progress: indicator.progress, detail: indicator.detail, url: indicator.url,
    observedAt: indicator.observedAt, reference: indicator.reference,
    entries: indicator.entries.map((entry) => {
      const started = entry.startedAt ? Date.parse(entry.startedAt) : Number.NaN;
      const live = entry.completedAt === null && (entry.state === "running" || entry.state === "queued");
      const ended = entry.completedAt ? Date.parse(entry.completedAt) : live ? now : Number.NaN;
      return {
        name: entry.name, state: entry.state, url: entry.url,
        startedAt: Number.isFinite(started) ? entry.startedAt : null,
        durationMs: Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null,
        live,
      };
    }),
  };
}
