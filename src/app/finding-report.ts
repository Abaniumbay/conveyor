// The finding report: how many durable findings exist by type, repository, author and UTC ISO week,
// and how often each type shows up in a review round. Computed read-only from the store. Every
// finding counts once by its stored type whatever its state. A review round is one review-stage run
// (with or without findings); a type's share is the rounds holding at least one finding of that type
// over all rounds. A finding belongs to the round of its run; an imported finding has no run, so it
// belongs to the review run of its issue that was active when it was first imported.

import type { ReportStore } from "../db/ports";
import type { ReportRoundRow } from "../db/reports";
import { FINDING_TYPES, type FindingType } from "../engine/finding-types";

export interface FindingReportOptions {
  /** Restrict to one repository id. */
  repositoryId?: string;
  /** Inclusive lower bound (ISO timestamp) on finding creation and on review-run start. */
  since?: string;
  /** The pipeline stage whose runs are review rounds. */
  reviewStage?: string;
}

export interface FindingTypeShare { type: FindingType; findings: number; rounds: number; share: number | null }

export interface FindingReport {
  total: number;
  byType: Record<FindingType, number>;
  byRepository: Record<string, number>;
  byAuthor: Record<string, number>;
  /** UTC ISO weeks as `YYYY-Www`. */
  byWeek: Record<string, number>;
  reviewRounds: number;
  typeShares: FindingTypeShare[];
}

/** The UTC ISO week (`YYYY-Www`) of an ISO timestamp. */
export function isoWeek(iso: string): string {
  const date = new Date(iso);
  const day = date.getUTCDay() || 7;
  const thursday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 4 - day);
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.ceil(((thursday - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const increment = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

export function buildFindingReport(store: ReportStore, options: FindingReportOptions = {}): FindingReport {
  const { repositoryId, since, reviewStage = "review" } = options;
  const findings = store.reports().findings(repositoryId ?? null, since ?? null);
  const rounds = store.reports().stageRuns(reviewStage, repositoryId ?? null, since ?? null);

  const report: FindingReport = {
    total: findings.length,
    byType: Object.fromEntries(FINDING_TYPES.map((type) => [type, 0])) as Record<FindingType, number>,
    byRepository: {}, byAuthor: {}, byWeek: {}, reviewRounds: rounds.length, typeShares: [],
  };
  const typesByRound = new Map<string, Set<string>>();
  const roundsByIssue = new Map<string, ReportRoundRow[]>();
  for (const round of rounds) roundsByIssue.set(round.issue_id, [...(roundsByIssue.get(round.issue_id) ?? []), round]);

  for (const finding of findings) {
    report.byType[finding.type as FindingType] += 1;
    increment(report.byRepository, finding.repository_id);
    increment(report.byAuthor, finding.author);
    increment(report.byWeek, isoWeek(finding.created_at));

    let roundId = finding.run_id;
    if (finding.run_id === null && finding.provider_key !== null) {
      roundId = (roundsByIssue.get(finding.issue_id) ?? []).find(
        (round) => round.started_at <= finding.created_at && (round.finished_at === null || finding.created_at <= round.finished_at),
      )?.id ?? null;
    }
    if (roundId === null) continue;
    typesByRound.set(roundId, (typesByRound.get(roundId) ?? new Set()).add(finding.type));
  }

  report.typeShares = FINDING_TYPES.map((type) => {
    const withType = rounds.filter((round) => typesByRound.get(round.id)?.has(type)).length;
    return { type, findings: report.byType[type], rounds: withType, share: rounds.length === 0 ? null : withType / rounds.length };
  });
  return report;
}

const ISO_8601 = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** An ISO 8601 date or timestamp as the UTC ISO timestamp the store compares with, or null when it is neither. */
export function parseSince(value: string): string | null {
  if (!ISO_8601.test(value)) return null;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number) as [number, number, number];
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}
