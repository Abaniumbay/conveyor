// Durable review findings: what a reviewer (an agent, or a person on the code host) said must
// change. The table is the authority; the code host's comments are projections of it, except for
// native human review, which is imported (and kept in sync) by `importNative`. Every state change
// appends a `finding_events` row, so the history of a finding is never lost.

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type { FINDING_CHANGES } from "../events/catalogue";
import { eventLog } from "../events/log";
import { DEFAULT_FINDING_TYPE, isFindingType, type FindingType } from "./finding-types";

export { DEFAULT_FINDING_TYPE, FINDING_TYPES, type FindingType } from "./finding-types";

type FindingChange = (typeof FINDING_CHANGES)[number];

export type FindingState = "open" | "resolved" | "dismissed" | "withdrawn";

export interface Finding {
  id: string;
  issueId: string;
  runId: string | null;
  providerKey: string | null;
  author: string;
  source: "agent" | "human";
  headSha: string;
  state: FindingState;
  path: string | null;
  line: number | null;
  url: string;
  body: string;
  type: FindingType;
  criterionIds: string[];
  /** How the finding is projected on the code host (opaque to this module). */
  projection: unknown;
  dismissal?: { actor: string; reason: string; at: string };
  withdrawal?: { actor: string; reason: "provider-artifact-deleted" | "provider-artifact-untrusted"; at: string };
}

export interface FindingEvent { kind: string; actor: string; reason: string | null; at: string; detail: unknown }

/** A review artifact of the code host's native review, as the host reports it. */
export interface NativeArtifact {
  providerKey: string;
  author: string | null;
  /** Whether the repository's current trust policy permits this artifact to become a finding. */
  trusted: boolean;
  body: string;
  url: string;
  path: string | null;
  line: number | null;
  resolved: boolean;
}

interface Row {
  id: string; issue_id: string; run_id: string | null; provider_key: string | null; author: string; source: string;
  head_sha: string; state: string; path: string | null; line: number | null; url: string; body: string;
  type: string; criterion_ids_json: string;
  projection_json: string | null; dismissal_json: string | null; withdrawal_json: string | null;
}

export interface SkippedNativeArtifact {
  providerKey: string;
  author: string | null;
  url: string;
  skippedAt: string;
  active: boolean;
}

const parse = (json: string | null): unknown => (json === null ? undefined : JSON.parse(json));

function findingType(value: string): FindingType {
  if (!isFindingType(value)) throw new Error(`Unknown stored review finding type: ${value}`);
  return value;
}

function inputFindingType(value: string | undefined): FindingType {
  if (value === undefined) return DEFAULT_FINDING_TYPE;
  if (!isFindingType(value)) throw new TypeError(`Unknown review finding type: ${value}`);
  return value;
}

function inputCriterionIds(value: readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  if (value.some((id) => typeof id !== "string")) throw new TypeError("Review finding criterion IDs must be strings.");
  return [...value];
}

function parseCriterionIds(json: string): string[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
    throw new Error("Stored review finding criterion IDs must be strings.");
  }
  return value;
}

function toFinding(row: Row): Finding {
  const finding: Finding = {
    id: row.id, issueId: row.issue_id, runId: row.run_id, providerKey: row.provider_key, author: row.author,
    source: row.source === "human" ? "human" : "agent", headSha: row.head_sha, state: row.state as FindingState,
    path: row.path, line: row.line, url: row.url, body: row.body, projection: parse(row.projection_json) ?? null,
    type: findingType(row.type), criterionIds: parseCriterionIds(row.criterion_ids_json),
  };
  const dismissal = parse(row.dismissal_json) as Finding["dismissal"];
  const withdrawal = parse(row.withdrawal_json) as Finding["withdrawal"];
  if (dismissal) finding.dismissal = dismissal;
  if (withdrawal) finding.withdrawal = withdrawal;
  return finding;
}

export class ReviewFindings {
  readonly #db: Database;

  constructor(database: Database) {
    this.#db = database;
  }

  #event(findingId: string, kind: FindingChange, actor: string, at: string, reason: string | null = null, detail: unknown = null): void {
    this.#db
      .query("INSERT INTO finding_events(finding_id, kind, actor, reason, at, detail_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(findingId, kind, actor, reason, at, detail === null ? null : JSON.stringify(detail));
    const owner = this.#db.query("SELECT issue_id, type FROM findings WHERE id = ?").get(findingId) as { issue_id: string; type: string } | null;
    if (owner === null) throw new Error(`Cannot record a change for missing finding ${findingId}.`);
    eventLog(this.#db).append("finding.changed", { findingId, type: findingType(owner.type), change: kind }, { issueId: owner.issue_id });
  }

  #insert(input: {
    issueId: string; runId: string | null; providerKey: string | null; author: string; source: "agent" | "human";
    headSha: string; path: string | null; line: number | null; url: string; body: string; type: FindingType; criterionIds: string[]; at: string;
  }): Finding {
    const id = randomUUID();
    this.#db
      .query(`INSERT INTO findings(id, issue_id, run_id, provider_key, author, source, head_sha, state, path, line, url, body, type, criterion_ids_json, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.issueId, input.runId, input.providerKey, input.author, input.source, input.headSha, input.path, input.line, input.url, input.body, input.type, JSON.stringify(input.criterionIds), input.at);
    this.#event(id, "created", input.author, input.at);
    return this.get(input.issueId, id)!;
  }

  /** An agent's finding: open, before any projection to the code host. */
  create(input: { issueId: string; runId: string | null; author: string; headSha: string; path?: string | null; line?: number | null; body: string; type?: FindingType; criterionIds?: readonly string[]; at?: string }): Finding {
    return this.#db.transaction(() => this.#insert({
      issueId: input.issueId, runId: input.runId, providerKey: null, author: input.author, source: "agent", headSha: input.headSha,
      path: input.path ?? null, line: input.line ?? null, url: "", body: input.body,
      type: inputFindingType(input.type), criterionIds: inputCriterionIds(input.criterionIds), at: input.at ?? new Date().toISOString(),
    }))();
  }

  get(issueId: string, id: string): Finding | null {
    const row = this.#db.query("SELECT * FROM findings WHERE issue_id = ? AND id = ?").get(issueId, id) as Row | null;
    return row ? toFinding(row) : null;
  }

  list(issueId: string): Finding[] {
    return (this.#db.query("SELECT * FROM findings WHERE issue_id = ? ORDER BY created_at, rowid").all(issueId) as Row[]).map(toFinding);
  }

  /** Findings safe to include in agent context under the current native-review trust decision. */
  listVisible(issueId: string): Finding[] {
    return (this.#db.query(`SELECT * FROM findings AS finding
      WHERE finding.issue_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM skipped_review_artifacts AS skipped
          WHERE skipped.issue_id = finding.issue_id
            AND skipped.provider_key = finding.provider_key
            AND skipped.active = 1
        )
      ORDER BY finding.created_at, finding.rowid`).all(issueId) as Row[]).map(toFinding);
  }

  /** Body-free provenance for native artifacts excluded by the current trust decision. */
  skippedNative(issueId: string): SkippedNativeArtifact[] {
    return this.#db.query(`SELECT provider_key, author, url, skipped_at, active
      FROM skipped_review_artifacts WHERE issue_id = ? ORDER BY skipped_at, rowid`).all(issueId).map((row) => {
      const skipped = row as { provider_key: string; author: string | null; url: string; skipped_at: string; active: number };
      return { providerKey: skipped.provider_key, author: skipped.author, url: skipped.url, skippedAt: skipped.skipped_at, active: skipped.active === 1 };
    });
  }

  /** Findings created by the run that are still open. */
  countForRun(runId: string): number {
    return (this.#db.query("SELECT COUNT(*) AS n FROM findings WHERE run_id = ? AND state = 'open'").get(runId) as { n: number }).n;
  }

  events(findingId: string): FindingEvent[] {
    const rows = this.#db.query("SELECT * FROM finding_events WHERE finding_id = ? ORDER BY id").all(findingId) as Array<{
      kind: string; actor: string; reason: string | null; at: string; detail_json: string | null;
    }>;
    return rows.map((row) => ({ kind: row.kind, actor: row.actor, reason: row.reason, at: row.at, detail: parse(row.detail_json) ?? null }));
  }

  /** Records where the finding lives on the code host. */
  project(id: string, url: string, projection: unknown): void {
    this.#db.query("UPDATE findings SET url = ?, projection_json = ? WHERE id = ?").run(url, JSON.stringify(projection), id);
  }

  /** open -> resolved; false (and no event) when the finding is not open. */
  resolve(issueId: string, id: string, actor: string, at = new Date().toISOString()): boolean {
    return this.#transition(issueId, id, "resolved", actor, at);
  }

  /** open -> dismissed with the person's reason; false when the finding is not open. */
  dismiss(issueId: string, id: string, dismissal: { actor: string; reason: string; at: string }): boolean {
    return this.#db.transaction(() => {
      const changed = this.#transition(issueId, id, "dismissed", dismissal.actor, dismissal.at, dismissal.reason);
      if (changed) this.#db.query("UPDATE findings SET dismissal_json = ? WHERE id = ?").run(JSON.stringify(dismissal), id);
      return changed;
    })();
  }

  #resolvedByAgent(id: string): boolean {
    const resolution = this.events(id).filter((event) => event.kind === "resolved").at(-1);
    return resolution !== undefined && resolution.actor !== "provider";
  }

  #transition(issueId: string, id: string, state: "resolved" | "dismissed", actor: string, at: string, reason: string | null = null): boolean {
    return this.#db.transaction(() => {
      const changes = this.#db.query("UPDATE findings SET state = ? WHERE issue_id = ? AND id = ? AND state = 'open'").run(state, issueId, id).changes;
      if (changes === 0) return false;
      this.#event(id, state, actor, at, reason);
      return true;
    })();
  }

  #skipNative(issueId: string, artifact: NativeArtifact, at: string): void {
    this.#db.query(`INSERT INTO skipped_review_artifacts(issue_id, provider_key, author, url, skipped_at, active)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(issue_id, provider_key) DO UPDATE SET active = 1`)
      .run(issueId, artifact.providerKey, artifact.author, artifact.url, at);
  }

  #markNativeTrusted(issueId: string, providerKey: string): void {
    this.#db.query("UPDATE skipped_review_artifacts SET active = 0 WHERE issue_id = ? AND provider_key = ?")
      .run(issueId, providerKey);
  }

  #withdrawUntrusted(finding: Finding, at: string): void {
    if (finding.state === "dismissed" || (finding.state === "withdrawn" && finding.withdrawal?.reason === "provider-artifact-untrusted")) return;
    const withdrawal = { actor: "provider", reason: "provider-artifact-untrusted" as const, at };
    this.#db.query("UPDATE findings SET state = 'withdrawn', withdrawal_json = ? WHERE id = ?").run(JSON.stringify(withdrawal), finding.id);
    this.#event(finding.id, "withdrawn", "provider", at, withdrawal.reason);
  }

  /**
   * Brings the findings imported from the code host's native review in line with `artifacts`:
   * new ones open, edited bodies update, resolved threads resolve, and an imported finding whose
   * artifact is gone is withdrawn. Dismissed findings and agent findings are never touched.
   */
  importNative(issueId: string, artifacts: readonly NativeArtifact[], headSha: string, at: string): void {
    this.#db.transaction(() => this.#importNative(issueId, artifacts, headSha, at))();
  }

  #importNative(issueId: string, artifacts: readonly NativeArtifact[], headSha: string, at: string): void {
    const imported = new Map(this.list(issueId).filter((f) => f.providerKey !== null).map((f) => [f.providerKey!, f]));
    const seen = new Set<string>();
    for (const artifact of artifacts) {
      seen.add(artifact.providerKey);
      const existing = imported.get(artifact.providerKey);
      if (!artifact.trusted) {
        this.#skipNative(issueId, artifact, at);
        if (existing) this.#withdrawUntrusted(existing, at);
        continue;
      }
      this.#markNativeTrusted(issueId, artifact.providerKey);
      // A trusted artifact always has an author because missing authors cannot be trusted.
      if (artifact.author === null) continue;
      if (!existing) {
        const finding = this.#insert({
          issueId, runId: null, providerKey: artifact.providerKey, author: artifact.author, source: "human", headSha,
          path: artifact.path, line: artifact.line, url: artifact.url, body: artifact.body,
          type: DEFAULT_FINDING_TYPE, criterionIds: [], at,
        });
        if (artifact.resolved) this.resolve(issueId, finding.id, "provider", at);
        continue;
      }
      if (existing.state === "dismissed") continue;
      if (existing.body !== artifact.body) {
        this.#db.query("UPDATE findings SET body = ?, url = ? WHERE id = ?").run(artifact.body, artifact.url, existing.id);
        this.#event(existing.id, "edited", artifact.author, at, null, { from: existing.body });
      }
      if (artifact.resolved) this.resolve(issueId, existing.id, "provider", at);
      else if (existing.state === "resolved" && artifact.providerKey.startsWith("review:") && this.#resolvedByAgent(existing.id)) {
        // A changes-requested review has nothing to resolve on the provider: the agent's answer stands.
      } else if (existing.state === "resolved" || existing.state === "withdrawn") {
        // The provider is authoritative for imported findings: an unresolved thread is open again.
        this.#db.query("UPDATE findings SET state = 'open', withdrawal_json = NULL WHERE id = ?").run(existing.id);
        this.#event(existing.id, "reopened", artifact.author, at, null, { from: existing.state });
      }
    }
    for (const finding of imported.values()) {
      if (seen.has(finding.providerKey!) || finding.state === "dismissed" || finding.state === "withdrawn") continue;
      const withdrawal = { actor: "provider", reason: "provider-artifact-deleted" as const, at };
      this.#db.query("UPDATE findings SET state = 'withdrawn', withdrawal_json = ? WHERE id = ?").run(JSON.stringify(withdrawal), finding.id);
      this.#event(finding.id, "withdrawn", "provider", at, withdrawal.reason);
    }
  }
}
