// The finding report: how many durable findings exist by type, repository, author and UTC ISO week,
// and how often each type shows up in a review round. Computed read-only from the store. Every
// finding counts once by its stored type whatever its state. A review round is one review-stage run
// (with or without findings); a type's share is the rounds holding at least one finding of that type
// over all rounds. A finding belongs to the round of its run; an imported finding has no run, so it
// belongs to the review run of its issue that was active when it was first imported.

import type { Database } from "bun:sqlite";

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

interface FindingRow { id: string; issue_id: string; run_id: string | null; provider_key: string | null; author: string; type: string; created_at: string; repository_id: string }
interface RoundRow { id: string; issue_id: string; started_at: string; finished_at: string | null }

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

export function buildFindingReport(db: Database, options: FindingReportOptions = {}): FindingReport {
  const { repositoryId, since, reviewStage = "review" } = options;
  const findings = db.query(
    `SELECT f.id, f.issue_id, f.run_id, f.provider_key, f.author, f.type, f.created_at, i.repository_id
       FROM findings f JOIN issues i ON i.id = f.issue_id
      WHERE (?1 IS NULL OR i.repository_id = ?1) AND (?2 IS NULL OR f.created_at >= ?2)`,
  ).all(repositoryId ?? null, since ?? null) as FindingRow[];
  const rounds = db.query(
    `SELECT r.id, r.issue_id, r.started_at, r.finished_at
       FROM runs r JOIN issues i ON i.id = r.issue_id
      WHERE r.stage_id = ?1 AND (?2 IS NULL OR i.repository_id = ?2) AND (?3 IS NULL OR r.started_at >= ?3)`,
  ).all(reviewStage, repositoryId ?? null, since ?? null) as RoundRow[];

  const report: FindingReport = {
    total: findings.length,
    byType: Object.fromEntries(FINDING_TYPES.map((type) => [type, 0])) as Record<FindingType, number>,
    byRepository: {}, byAuthor: {}, byWeek: {}, reviewRounds: rounds.length, typeShares: [],
  };
  const typesByRound = new Map<string, Set<string>>();
  const roundsByIssue = new Map<string, RoundRow[]>();
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
