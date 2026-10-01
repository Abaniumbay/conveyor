// Durable review findings: what a reviewer (an agent, or a person on the code host) said must
// change. The table is the authority; the code host's comments are projections of it, except for
// native human review, which is imported (and kept in sync) by `importNative`. Every state change
// appends a `finding_events` row, so the history of a finding is never lost.

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

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
  /** How the finding is projected on the code host (opaque to this module). */
  projection: unknown;
  dismissal?: { actor: string; reason: string; at: string };
  withdrawal?: { actor: string; reason: "provider-artifact-deleted"; at: string };
}

export interface FindingEvent { kind: string; actor: string; reason: string | null; at: string; detail: unknown }

/** A review artifact of the code host's native review, as the host reports it. */
export interface NativeArtifact {
  providerKey: string;
  author: string;
  body: string;
  url: string;
  path: string | null;
  line: number | null;
  resolved: boolean;
}

interface Row {
  id: string; issue_id: string; run_id: string | null; provider_key: string | null; author: string; source: string;
  head_sha: string; state: string; path: string | null; line: number | null; url: string; body: string;
  projection_json: string | null; dismissal_json: string | null; withdrawal_json: string | null;
}

const parse = (json: string | null): unknown => (json === null ? undefined : JSON.parse(json));

function toFinding(row: Row): Finding {
  const finding: Finding = {
    id: row.id, issueId: row.issue_id, runId: row.run_id, providerKey: row.provider_key, author: row.author,
    source: row.source === "human" ? "human" : "agent", headSha: row.head_sha, state: row.state as FindingState,
    path: row.path, line: row.line, url: row.url, body: row.body, projection: parse(row.projection_json) ?? null,
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

  #event(findingId: string, kind: string, actor: string, at: string, reason: string | null = null, detail: unknown = null): void {
    this.#db
      .query("INSERT INTO finding_events(finding_id, kind, actor, reason, at, detail_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(findingId, kind, actor, reason, at, detail === null ? null : JSON.stringify(detail));
  }

  #insert(input: {
    issueId: string; runId: string | null; providerKey: string | null; author: string; source: "agent" | "human";
    headSha: string; path: string | null; line: number | null; url: string; body: string; at: string;
  }): Finding {
    const id = randomUUID();
    this.#db
      .query(`INSERT INTO findings(id, issue_id, run_id, provider_key, author, source, head_sha, state, path, line, url, body, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`)
      .run(id, input.issueId, input.runId, input.providerKey, input.author, input.source, input.headSha, input.path, input.line, input.url, input.body, input.at);
    this.#event(id, "created", input.author, input.at);
    return this.get(input.issueId, id)!;
  }

  /** An agent's finding: open, before any projection to the code host. */
  create(input: { issueId: string; runId: string | null; author: string; headSha: string; path?: string | null; line?: number | null; body: string; at?: string }): Finding {
    return this.#insert({
      issueId: input.issueId, runId: input.runId, providerKey: null, author: input.author, source: "agent", headSha: input.headSha,
      path: input.path ?? null, line: input.line ?? null, url: "", body: input.body, at: input.at ?? new Date().toISOString(),
    });
  }

  get(issueId: string, id: string): Finding | null {
    const row = this.#db.query("SELECT * FROM findings WHERE issue_id = ? AND id = ?").get(issueId, id) as Row | null;
    return row ? toFinding(row) : null;
  }

  list(issueId: string): Finding[] {
    return (this.#db.query("SELECT * FROM findings WHERE issue_id = ? ORDER BY created_at, rowid").all(issueId) as Row[]).map(toFinding);
  }

  countForRun(runId: string): number {
    return (this.#db.query("SELECT COUNT(*) AS n FROM findings WHERE run_id = ?").get(runId) as { n: number }).n;
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
    const changed = this.#transition(issueId, id, "dismissed", dismissal.actor, dismissal.at, dismissal.reason);
    if (changed) this.#db.query("UPDATE findings SET dismissal_json = ? WHERE id = ?").run(JSON.stringify(dismissal), id);
    return changed;
  }

  #transition(issueId: string, id: string, state: FindingState, actor: string, at: string, reason: string | null = null): boolean {
    const changes = this.#db.query("UPDATE findings SET state = ? WHERE issue_id = ? AND id = ? AND state = 'open'").run(state, issueId, id).changes;
    if (changes === 0) return false;
    this.#event(id, state, actor, at, reason);
    return true;
  }

  /**
   * Brings the findings imported from the code host's native review in line with `artifacts`:
   * new ones open, edited bodies update, resolved threads resolve, and an imported finding whose
   * artifact is gone is withdrawn. Dismissed findings and agent findings are never touched.
   */
  importNative(issueId: string, artifacts: readonly NativeArtifact[], headSha: string, at: string): void {
    const imported = new Map(this.list(issueId).filter((f) => f.providerKey !== null).map((f) => [f.providerKey!, f]));
    const seen = new Set<string>();
    for (const artifact of artifacts) {
      seen.add(artifact.providerKey);
      const existing = imported.get(artifact.providerKey);
      if (!existing) {
        const finding = this.#insert({
          issueId, runId: null, providerKey: artifact.providerKey, author: artifact.author, source: "human", headSha,
          path: artifact.path, line: artifact.line, url: artifact.url, body: artifact.body, at,
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
    }
    for (const finding of imported.values()) {
      if (seen.has(finding.providerKey!) || finding.state === "dismissed" || finding.state === "withdrawn") continue;
      const withdrawal = { actor: "provider", reason: "provider-artifact-deleted" as const, at };
      this.#db.query("UPDATE findings SET state = 'withdrawn', withdrawal_json = ? WHERE id = ?").run(JSON.stringify(withdrawal), finding.id);
      this.#event(finding.id, "withdrawn", "provider", at, withdrawal.reason);
    }
  }
}
