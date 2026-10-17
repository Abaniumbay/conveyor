import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { Indicator, StoredIndicator } from "../app/indicators";
import { ExecutionStore } from "../engine/journal";
import { eventLog, type EventLog } from "../events/log";
import { EventThrottle } from "../events/throttle";
import type { NormalizedGitHubEvent } from "../source/github/events";
import { migrations } from "./migrations";

export interface RepositoryRecord {
  id: string;
  configName: string;
  source: string;
  address: string;
  folder: string;
  configHash: string;
}

export type RepositoryVisibility = "public" | "private" | "unknown";

/** Last observed source visibility for operator-facing repository trust status. */
export interface RepositoryTrustStatus {
  repositoryId: string;
  visibility: RepositoryVisibility;
  checkedAt: string;
  warning: string | null;
}

/** The GitHub issue type and the organization issue-field values Conveyor shows beside labels. */
export interface IssueMetadata {
  type: string | null;
  fields: Record<string, string>;
  /** The source `updatedAt` at which the field values were last read from GitHub. */
  fieldsSyncedAt?: string;
}

export interface IssueProjection {
  id: string;
  repositoryId: string;
  sourceNumber: number;
  sourceUrl: string;
  title: string;
  body: string;
  sourceState: string;
  sourceStateReason?: string | null;
  labels: string[];
  sourceUpdatedAt: string;
  /** When title and body were last admitted into the agent-visible source snapshot. */
  acceptedTextAt?: string | null;
  parentId?: string | null;
  /** The issue type the source reports; undefined leaves the stored type as it is. */
  issueType?: string | null;
}

/** Authoritative test evidence recorded for one acceptance criterion. */
export interface CriterionTestEvidence {
  criterionId: string;
  manual: boolean;
  tests: Array<{ name: string; file: string; line?: number; description?: string }>;
  recordedHead: string;
  sourceLinkHead: string;
  recordedAt: string;
}

export interface StoredIssue extends IssueProjection {
  metadata: IssueMetadata;
  queueRank: number | null;
  projectedStage: string | null;
  projectedState: string | null;
  warning: string | null;
}

export interface CostSummary {
  runs: number;
  amount: number;
  currency: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  unavailableRuns: number;
}

/** SQL-side definition of the Done lane used by the dashboard. */
export interface FinishedIssueCountQuery {
  repositoryIds: readonly string[];
  words: readonly string[];
  workflows: ReadonlyArray<{
    repositoryId: string;
    stages: readonly string[];
    sourceStageLabels: readonly string[];
  }>;
  /** Searchable configured actors keyed by the repository and stage that own them. */
  stageActors: ReadonlyArray<{ repositoryId: string; stageId: string; text: string }>;
}

export interface DashboardAccount {
  id: string;
  username: string;
  passwordHash: string;
  role: "superuser" | "user";
  avatar: string;
  sessionVersion: number;
}

export type DashboardAccountDeletion = "deleted" | "not_found" | "superuser";

export interface PushPreferences {
  questions: boolean;
  stopped: boolean;
  done: boolean;
}

export interface PushSubscription {
  id: string;
  accountId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushEvent {
  id: string;
  category: "questions" | "stopped" | "done";
  target: string;
}

export interface SourceMutation {
  id: string;
  idempotencyKey: string;
  source: string;
  operation: string;
  status: string;
  request: unknown;
  response: unknown | null;
  error: string | null;
}

export interface RunRecordInput {
  id: string;
  issueId: string | null;
  stageId: string;
  attempt: number;
  kind: string;
  status: string;
  configHash: string;
  startedAt: string;
}

export interface StoredRun {
  id: string;
  issueId: string | null;
  stageId: string;
  attempt: number;
  kind: string;
  status: string;
  sessionId: string | null;
  result: unknown | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ActiveIssueRun {
  id: string;
  issueId: string;
  repository: string;
  issueNumber: number;
  issueTitle: string;
  stageId: string;
  kind: string;
  startedAt: string;
}

export interface EnrollmentRecord {
  id: string;
  issueId: string;
  generation: number;
  status: string;
  startedAt: string;
  endedAt: string | null;
}

export interface StoredWorkspace {
  id: string;
  enrollmentId: string;
  issueId: string;
  generation: number;
  path: string;
  branch: string;
  status: string;
}

export interface StoredPullRequest {
  id: string;
  issueId: string;
  number: number;
  url: string;
  state: string;
  mergedAt: string | null;
  updatedAt: string;
}

export interface StoredStageState {
  issueId: string;
  stageId: string;
  status: string;
  feedbackCycle: number;
  configHash: string;
  updatedAt: string;
}

export interface StageTransitionDetail {
  reason: string | null;
  requiredFixes: string[];
  resultStatus: string | null;
  actor?: { name: string; title: string | null } | null;
  sourceSnapshot?: { title: string; body: string } | null;
}

export interface StoredStageTransition extends StageTransitionDetail {
  id: string;
  issueId: string;
  fromStage: string | null;
  toStage: string | null;
  kind: string;
  status: string;
  sourceMutationId: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** A durable source record for the cross-repository Recent feed. */
export interface StoredRecentActivity {
  id: string;
  source: "transition" | "done" | "done-fallback";
  issueId: string;
  repositoryId: string;
  issueNumber: number;
  issueTitle: string;
  occurredAt: string;
  fromStage: string | null;
  toStage: string | null;
  kind: string;
  resultStatus: string | null;
  reason: string | null;
}

export interface StoredQuestion {
  id: string;
  issueId: string;
  runId: string | null;
  prompt: string;
  reason: string;
  options: unknown[];
  minSelections: number;
  maxSelections: number;
  allowFreeText: boolean;
  status: string;
  createdAt: string;
  answeredAt: string | null;
  answer: unknown | null;
  /** Immutable actor label, retained even when their dashboard account is deleted. */
  answerSource: string | null;
}

export interface StoredConversationMessage {
  id: number;
  issueId: string;
  runId: string | null;
  stageId: string | null;
  questionId: string | null;
  actorType: string;
  actorId: string;
  actorName: string;
  actorTitle: string | null;
  message: string;
  createdAt: string;
}

function now(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: string | null): T | null {
  return value === null ? null : (JSON.parse(value) as T);
}

function parseMetadata(value: string | null): IssueMetadata {
  const parsed = parseJson<Partial<IssueMetadata>>(value);
  return {
    type: parsed?.type ?? null,
    fields: parsed?.fields ?? {},
    ...(parsed?.fieldsSyncedAt !== undefined ? { fieldsSyncedAt: parsed.fieldsSyncedAt } : {}),
  };
}

/** Status changes the stage executor makes to itself; they never fence the item. */
const EXECUTOR_STATUSES = new Set(["ready", "running", "error", "interrupted"]);

const CONVERSATION_MESSAGE_LIMIT = 4_000;

/** Keeps the start of a system message (the summary and first failures) and says how much was cut. */
function trimToLimit(message: string): string {
  const note = (omitted: number) => `\n… (${omitted} characters omitted)`;
  const budget = CONVERSATION_MESSAGE_LIMIT - note(message.length).length;
  const cut = message.lastIndexOf("\n", budget) > budget / 2 ? message.lastIndexOf("\n", budget) : budget;
  return `${message.slice(0, cut).trimEnd()}${note(message.length - cut)}`;
}

/** The schema this build migrates databases to. */
export const LATEST_SCHEMA_VERSION = Math.max(...migrations.map((migration) => migration.version));

/** The database was migrated by a newer Conveyor; running an older one against it is unsafe. */
export class NewerSchemaError extends Error {
  override readonly name = "NewerSchemaError";

  constructor(readonly schemaVersion: number) {
    super(
      `the database schema (${schemaVersion}) is newer than this Conveyor supports (${LATEST_SCHEMA_VERSION}): a newer release migrated it. ` +
      "Run that release again, or restore the pre-upgrade backup with conveyor rollback --restore-backup.",
    );
  }
}

/** The number of dashboard accounts, read without migrating the database; 0 when it has none yet. */
export function dashboardAccountCount(filename: string): number {
  const database = new Database(filename, { readonly: true });
  try {
    const table = database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dashboard_accounts'").get();
    return table ? (database.query("SELECT COUNT(*) AS count FROM dashboard_accounts").get() as { count: number }).count : 0;
  } finally {
    database.close();
  }
}

/** The schema version of a database file, read without migrating it; 0 when it has none. */
export function databaseSchemaVersion(filename: string): number {
  const database = new Database(filename, { readonly: true });
  try {
    const table = database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (!table) return 0;
    return (database.query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number }).version;
  } finally {
    database.close();
  }
}

export class ConveyorStore {
  readonly #database: Database;
  readonly #executions: ExecutionStore;
  readonly #events: EventLog;
  /** Transcript lines are many: they are recorded as at most one `run.progressed` per run and second. */
  readonly #runProgress: EventThrottle;

  private constructor(database: Database) {
    this.#database = database;
    this.#executions = new ExecutionStore(database);
    this.#events = eventLog(database);
    this.#runProgress = new EventThrottle(1_000, (runId) => {
      const owner = this.#database.query("SELECT issue_id FROM runs WHERE id = ?").get(runId) as { issue_id: string | null } | null;
      this.#events.append("run.progressed", { runId }, { issueId: owner?.issue_id ?? null });
    });
  }

  /**
   * Opens (creating when absent) and migrates the database. With `migrateExisting: false`, as the
   * CLI's direct operations use, a new database is still initialised but an existing one at another
   * schema is refused: only the service and an upgrade, which backs up first, migrate it.
   */
  static async open(filename: string, options: { migrateExisting?: boolean } = {}): Promise<ConveyorStore> {
    await mkdir(path.dirname(filename), { recursive: true });
    const database = new Database(filename, { create: true, strict: true });
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    const store = new ConveyorStore(database);
    try {
      if (options.migrateExisting === false) store.requireCurrentSchema();
      store.migrate();
    } catch (error) {
      database.close();
      throw error;
    }
    return store;
  }

  close(): void {
    this.#database.close(false);
  }

  /** The durable task-chain journal: context, cursor, wake-ups and epochs. */
  executions(): ExecutionStore {
    return this.#executions;
  }

  /** The append-only event log every write of this database records its change in. */
  events(): EventLog {
    return this.#events;
  }

  /** The underlying database, shared with ExecutionStore. */
  sqlite(): Database {
    return this.#database;
  }

  pragma(name: "journal_mode" | "foreign_keys"): unknown[] {
    return this.#database.query(`PRAGMA ${name}`).all();
  }

  schemaVersion(): number {
    const row = this.#database
      .query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { version: number };
    return row.version;
  }

  criterionTestEvidence(issueId: string): CriterionTestEvidence[] {
    const rows = this.#database.query(`
      SELECT e.criterion_id AS criterionId, e.manual AS manual, e.recorded_head_sha AS recordedHead,
             e.source_link_head_sha AS sourceLinkHead, e.recorded_at AS recordedAt,
             t.ordinal AS ordinal, t.name AS name, t.file AS file, t.line AS line, t.description AS description
        FROM criterion_test_evidence e
        LEFT JOIN criterion_test_evidence_tests t ON t.issue_id = e.issue_id AND t.criterion_id = e.criterion_id
       WHERE e.issue_id = ?
       ORDER BY e.criterion_id, t.ordinal
    `).all(issueId) as Array<{ criterionId: string; manual: number; recordedHead: string; sourceLinkHead: string; recordedAt: string; ordinal: number | null; name: string | null; file: string | null; line: number | null; description: string | null }>;
    const evidence = new Map<string, CriterionTestEvidence>();
    for (const row of rows) {
      let entry = evidence.get(row.criterionId);
      if (!entry) {
        entry = { criterionId: row.criterionId, manual: row.manual === 1, tests: [], recordedHead: row.recordedHead, sourceLinkHead: row.sourceLinkHead, recordedAt: row.recordedAt };
        evidence.set(row.criterionId, entry);
      }
      if (row.name !== null && row.file !== null) {
        const test: { name: string; file: string; line?: number; description?: string } = { name: row.name, file: row.file };
        if (row.line !== null) test.line = row.line;
        if (row.description !== null) test.description = row.description;
        entry.tests.push(test);
      }
    }
    return [...evidence.values()];
  }

  replaceCriterionTestEvidence(issueId: string, entries: readonly CriterionTestEvidence[]): void {
    const replace = this.#database.transaction(() => {
      const deleteTests = this.#database.query("DELETE FROM criterion_test_evidence_tests WHERE issue_id = ? AND criterion_id = ?");
      const deleteEvidence = this.#database.query("DELETE FROM criterion_test_evidence WHERE issue_id = ? AND criterion_id = ?");
      const insertEvidence = this.#database.query("INSERT INTO criterion_test_evidence (issue_id, criterion_id, manual, recorded_head_sha, source_link_head_sha, recorded_at) VALUES (?, ?, ?, ?, ?, ?)");
      const insertTest = this.#database.query("INSERT INTO criterion_test_evidence_tests (issue_id, criterion_id, ordinal, name, file, line, description) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const entry of entries) {
        deleteTests.run(issueId, entry.criterionId);
        deleteEvidence.run(issueId, entry.criterionId);
        insertEvidence.run(issueId, entry.criterionId, entry.manual ? 1 : 0, entry.recordedHead, entry.sourceLinkHead, entry.recordedAt);
        entry.tests.forEach((test, ordinal) => insertTest.run(issueId, entry.criterionId, ordinal, test.name, test.file, test.line ?? null, test.description ?? null));
      }
      if (entries.length > 0) this.#events.append("criterion.testsRecorded", { criteria: entries.map((entry) => entry.criterionId) }, { issueId });
    });
    replace();
  }

  refreshCriterionTestEvidence(issueId: string, sourceLinkHead: string, lines: ReadonlyMap<string, readonly number[]>): void {
    const refresh = this.#database.transaction(() => {
      const updateHeader = this.#database.query("UPDATE criterion_test_evidence SET source_link_head_sha = ? WHERE issue_id = ? AND criterion_id = ?");
      const updateLine = this.#database.query("UPDATE criterion_test_evidence_tests SET line = ? WHERE issue_id = ? AND criterion_id = ? AND ordinal = ?");
      for (const [criterionId, testLines] of lines) {
        updateHeader.run(sourceLinkHead, issueId, criterionId);
        testLines.forEach((line, ordinal) => updateLine.run(line, issueId, criterionId, ordinal));
      }
    });
    refresh();
  }

  dashboardAccounts(): DashboardAccount[] {
    return this.#database.query(`SELECT id, username, password_hash AS passwordHash, role, avatar, session_version AS sessionVersion FROM dashboard_accounts ORDER BY role DESC, username COLLATE NOCASE`).all() as DashboardAccount[];
  }

  dashboardAccountById(id: string): DashboardAccount | null {
    return (this.#database.query(`SELECT id, username, password_hash AS passwordHash, role, avatar, session_version AS sessionVersion FROM dashboard_accounts WHERE id = ?`).get(id) as DashboardAccount | undefined) ?? null;
  }

  dashboardAccountByUsername(username: string): DashboardAccount | null {
    return (this.#database.query(`SELECT id, username, password_hash AS passwordHash, role, avatar, session_version AS sessionVersion FROM dashboard_accounts WHERE username = ? COLLATE NOCASE`).get(username) as DashboardAccount | undefined) ?? null;
  }

  getPushPreferences(accountId: string): PushPreferences {
    const row = this.#database.query("SELECT questions, stopped, done FROM push_preferences WHERE account_id = ?").get(accountId) as { questions: number; stopped: number; done: number } | null;
    return row ? { questions: row.questions === 1, stopped: row.stopped === 1, done: row.done === 1 } : { questions: false, stopped: false, done: false };
  }

  setPushPreferences(accountId: string, preferences: PushPreferences): void {
    this.#database.transaction(() => {
      this.#database.query(`INSERT INTO push_preferences(account_id, questions, stopped, done, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET questions = excluded.questions, stopped = excluded.stopped, done = excluded.done, updated_at = excluded.updated_at`)
        .run(accountId, Number(preferences.questions), Number(preferences.stopped), Number(preferences.done), now());
      this.#events.append("notifications.settingsChanged", { accountId });
      if (!preferences.questions && !preferences.stopped && !preferences.done) this.deletePushSubscriptions(accountId);
    })();
  }

  putPushSubscription(accountId: string, endpoint: string, keys: { p256dh: string; auth: string }): void {
    this.#database.transaction(() => {
      this.#database.query("DELETE FROM push_subscriptions WHERE endpoint = ? AND account_id <> ?").run(endpoint, accountId);
      this.#database.query(`INSERT INTO push_subscriptions(id, account_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`)
        .run(randomUUID(), accountId, endpoint, keys.p256dh, keys.auth, now());
      this.#events.append("notifications.subscribed", { accountId });
    })();
  }

  deletePushSubscription(accountId: string, endpoint: string): void {
    this.#database.transaction(() => {
      const removed = this.#database.query("DELETE FROM push_subscriptions WHERE account_id = ? AND endpoint = ?").run(accountId, endpoint);
      if (removed.changes > 0) this.#events.append("notifications.unsubscribed", { accountId });
    })();
  }

  deletePushSubscriptions(accountId: string): void {
    this.#database.transaction(() => {
      const removed = this.#database.query("DELETE FROM push_subscriptions WHERE account_id = ?").run(accountId);
      if (removed.changes > 0) this.#events.append("notifications.unsubscribed", { accountId });
    })();
  }

  listPushSubscriptions(accountId: string): PushSubscription[] {
    const rows = this.#database.query("SELECT id, account_id, endpoint, p256dh, auth FROM push_subscriptions WHERE account_id = ?").all(accountId) as Array<{ id: string; account_id: string; endpoint: string; p256dh: string; auth: string }>;
    return rows.map((row) => ({ id: row.id, accountId: row.account_id, endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }));
  }

  recordPushEvent(event: PushEvent): void {
    this.#database.transaction(() => {
      const inserted = this.#database.query("INSERT INTO push_events(id, category, target, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
        .run(event.id, event.category, event.target, now());
      if (inserted.changes === 0) return;
      this.#database.query(`INSERT INTO push_event_subscriptions(event_id, subscription_id)
        SELECT ?, s.id FROM push_subscriptions s JOIN push_preferences p ON p.account_id = s.account_id WHERE p.${event.category} = 1`)
        .run(event.id);
    })();
  }

  pendingPushEvents(): PushEvent[] {
    return this.#database.query(`SELECT e.id, e.category, e.target FROM push_events e
      WHERE EXISTS (SELECT 1 FROM push_event_subscriptions es WHERE es.event_id = e.id
        AND NOT EXISTS (SELECT 1 FROM push_deliveries d WHERE d.event_id = es.event_id AND d.subscription_id = es.subscription_id))
      ORDER BY e.created_at, e.id`).all() as PushEvent[];
  }

  pushEventSubscriptions(eventId: string): PushSubscription[] {
    const rows = this.#database.query(`SELECT s.id, s.account_id, s.endpoint, s.p256dh, s.auth FROM push_event_subscriptions es
      JOIN push_subscriptions s ON s.id = es.subscription_id WHERE es.event_id = ?`).all(eventId) as Array<{ id: string; account_id: string; endpoint: string; p256dh: string; auth: string }>;
    return rows.map((row) => ({ id: row.id, accountId: row.account_id, endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }));
  }

  claimPushDelivery(eventId: string, subscriptionId: string): boolean {
    const result = this.#database.query("INSERT INTO push_deliveries(event_id, subscription_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(eventId, subscriptionId);
    return result.changes > 0;
  }

  seedDashboardSuperuser(username: string, passwordHash: string): void {
    this.#database.transaction(() => {
      if (this.#database.query("SELECT 1 FROM dashboard_accounts LIMIT 1").get()) return;
      const id = randomUUID();
      this.#database.query(`INSERT INTO dashboard_accounts(id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'superuser', ?)`).run(id, username, passwordHash, now());
      this.#events.append("account.created", { accountId: id, role: "superuser" });
    })();
  }

  createDashboardUser(username: string, passwordHash: string): DashboardAccount {
    const id = randomUUID();
    this.#database.transaction(() => {
      this.#database.query(`INSERT INTO dashboard_accounts(id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'user', ?)`).run(id, username, passwordHash, now());
      this.#events.append("account.created", { accountId: id, role: "user" });
    })();
    return this.dashboardAccountById(id)!;
  }

  changeDashboardPassword(id: string, passwordHash: string): void {
    this.#database.transaction(() => {
      const changed = this.#database.query("UPDATE dashboard_accounts SET password_hash = ?, session_version = session_version + 1 WHERE id = ?").run(passwordHash, id);
      if (changed.changes > 0) this.#events.append("account.passwordChanged", { accountId: id });
    })();
  }

  deleteDashboardAccount(id: string): DashboardAccountDeletion {
    return this.#database.transaction(() => {
      const account = this.dashboardAccountById(id);
      if (!account) return "not_found";
      if (account.role === "superuser") return "superuser";
      this.#database.query("DELETE FROM dashboard_accounts WHERE id = ?").run(id);
      this.#events.append("account.deleted", { accountId: id });
      return "deleted";
    })();
  }

  changeDashboardAvatar(id: string, avatar: string): void {
    this.#database.transaction(() => {
      const changed = this.#database.query("UPDATE dashboard_accounts SET avatar = ? WHERE id = ? AND avatar IS NOT ?").run(avatar, id, avatar);
      if (changed.changes > 0) this.#events.append("account.avatarChanged", { accountId: id });
    })();
  }

  /** Throws unless the database is new or already at this build's schema. */
  private requireCurrentSchema(): void {
    const table = this.#database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (!table) return;
    const current = this.schemaVersion();
    if (current === 0 || current === LATEST_SCHEMA_VERSION) return;
    if (current > LATEST_SCHEMA_VERSION) throw new NewerSchemaError(current);
    throw new Error(
      `the database schema (${current}) is older than this Conveyor's (${LATEST_SCHEMA_VERSION}); this command does not migrate it. ` +
      "Use the conveyor that the service runs, or upgrade with conveyor upgrade, which backs up the database first.",
    );
  }

  private migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    const apply = this.#database.transaction((version: number, sql: string) => {
      this.#database.exec(sql);
      this.#database
        .query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(version, now());
    });
    const current = this.schemaVersion();
    if (current > LATEST_SCHEMA_VERSION) {
      throw new NewerSchemaError(current);
    }
    for (const migration of migrations) {
      if (migration.version > current) apply(migration.version, migration.sql);
    }
  }

  recordConfigSnapshot(hash: string, config: unknown): void {
    this.#database.transaction(() => {
      const inserted = this.#database
        .query(
          `INSERT INTO config_snapshots(hash, config_json, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT(hash) DO NOTHING`,
        )
        .run(hash, json(config), now());
      if (inserted.changes > 0) this.#events.append("config.recorded", { hash });
    })();
  }

  upsertRepository(repository: RepositoryRecord): void {
    const timestamp = now();
    const before = this.#database
      .query("SELECT config_name, source, address, folder, config_hash FROM repositories WHERE id = ?")
      .get(repository.id) as { config_name: string; source: string; address: string; folder: string; config_hash: string } | null;
    const unchanged = before !== null && before.config_name === repository.configName && before.source === repository.source
      && before.address === repository.address && before.folder === repository.folder && before.config_hash === repository.configHash;
    if (unchanged) return;
    this.#database.transaction(() => this.#database
      .query(
        `INSERT INTO repositories(
           id, config_name, source, address, folder, config_hash, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           config_name = excluded.config_name,
           source = excluded.source,
           address = excluded.address,
           folder = excluded.folder,
           config_hash = excluded.config_hash,
           updated_at = excluded.updated_at`,
      )
      .run(
        repository.id,
        repository.configName,
        repository.source,
        repository.address,
        repository.folder,
        repository.configHash,
        timestamp,
        timestamp,
      ))();
    this.#events.append("repository.onboarded", { address: repository.address }, { repositoryId: repository.id });
  }

  setRepositoryTrustStatus(status: RepositoryTrustStatus): void {
    const previous = this.repositoryTrustStatus(status.repositoryId)?.visibility ?? null;
    this.#database.transaction(() => {
      this.#database
      .query(
        `INSERT INTO repository_trust_statuses(repository_id, visibility, checked_at, warning)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(repository_id) DO UPDATE SET
           visibility = excluded.visibility,
           checked_at = excluded.checked_at,
           warning = excluded.warning`,
      )
      .run(status.repositoryId, status.visibility, status.checkedAt, status.warning);
      if (previous !== status.visibility) this.#events.append("repository.trustChanged", { visibility: status.visibility }, { repositoryId: status.repositoryId });
    })();
  }

  repositoryTrustStatus(repositoryId: string): RepositoryTrustStatus | null {
    const row = this.#database
      .query("SELECT repository_id, visibility, checked_at, warning FROM repository_trust_statuses WHERE repository_id = ?")
      .get(repositoryId) as { repository_id: string; visibility: string; checked_at: string; warning: string | null } | null;
    if (!row) return null;
    if (row.visibility !== "public" && row.visibility !== "private" && row.visibility !== "unknown") {
      throw new Error(`Invalid repository trust visibility for ${repositoryId}`);
    }
    return {
      repositoryId: row.repository_id,
      visibility: row.visibility,
      checkedAt: row.checked_at,
      warning: row.warning,
    };
  }

  removeRepositoriesExcept(configuredIds: readonly string[]): string[] {
    const configured = [...new Set(configuredIds)];
    const placeholders = configured.map(() => "?").join(", ");
    const rows = (configured.length > 0
      ? this.#database
          .query(`SELECT id FROM repositories WHERE id NOT IN (${placeholders}) ORDER BY id`)
          .all(...configured)
      : this.#database.query("SELECT id FROM repositories ORDER BY id").all()) as Array<{
      id: string;
    }>;
    if (rows.length === 0) return [];

    const remove = this.#database.transaction((repositoryIds: readonly string[]) => {
      const statement = this.#database.query("DELETE FROM repositories WHERE id = ?");
      for (const repositoryId of repositoryIds) {
        statement.run(repositoryId);
        this.#events.append("repository.removed", {}, { repositoryId });
      }
    });
    const removed = rows.map((row) => row.id);
    remove(removed);
    return removed;
  }

  upsertIssue(issue: IssueProjection): void {
    this.#database.transaction(() => this.#upsertIssue(issue))();
  }

  #upsertIssue(issue: IssueProjection): void {
    const timestamp = now();
    const labels = [...new Set(issue.labels)].sort((left, right) => left.localeCompare(right));
    const before = this.#database
      .query("SELECT title, body, source_state, source_state_reason, labels_json, parent_id, accepted_text_at FROM issues WHERE id = ?")
      .get(issue.id) as { title: string; body: string; source_state: string; source_state_reason: string | null; labels_json: string; parent_id: string | null; accepted_text_at: string | null } | null;
    this.#database
      .query(
        `INSERT INTO issues(
           id, repository_id, source_number, source_url, title, body, source_state,
           source_state_reason, labels_json, source_updated_at, accepted_text_at, parent_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           repository_id = excluded.repository_id,
           source_number = excluded.source_number,
           source_url = excluded.source_url,
           title = excluded.title,
           body = excluded.body,
           source_state = excluded.source_state,
           source_state_reason = excluded.source_state_reason,
           labels_json = excluded.labels_json,
           source_updated_at = excluded.source_updated_at,
           accepted_text_at = COALESCE(excluded.accepted_text_at, issues.accepted_text_at),
           parent_id = COALESCE(excluded.parent_id, issues.parent_id),
           updated_at = CASE WHEN
             issues.repository_id IS NOT excluded.repository_id OR
             issues.source_number IS NOT excluded.source_number OR
             issues.source_url IS NOT excluded.source_url OR
             issues.title IS NOT excluded.title OR
             issues.body IS NOT excluded.body OR
             issues.source_state IS NOT excluded.source_state OR
             issues.source_state_reason IS NOT excluded.source_state_reason OR
             issues.labels_json IS NOT excluded.labels_json OR
             issues.source_updated_at IS NOT excluded.source_updated_at OR
             issues.accepted_text_at IS NOT COALESCE(excluded.accepted_text_at, issues.accepted_text_at) OR
             issues.parent_id IS NOT COALESCE(excluded.parent_id, issues.parent_id)
           THEN excluded.updated_at ELSE issues.updated_at END`,
      )
      .run(
        issue.id,
        issue.repositoryId,
        issue.sourceNumber,
        issue.sourceUrl,
        issue.title,
        issue.body,
        issue.sourceState,
        issue.sourceStateReason ?? null,
        json(labels),
        issue.sourceUpdatedAt,
        issue.acceptedTextAt ?? null,
        issue.parentId ?? null,
        timestamp,
        timestamp,
      );
    const scope = { repositoryId: issue.repositoryId, issueId: issue.id };
    if (!before) {
      this.#events.append("item.discovered", { number: issue.sourceNumber }, scope);
    } else {
      const changed: Array<"title" | "body" | "state" | "labels" | "parent" | "acceptedText"> = [];
      if (before.title !== issue.title) changed.push("title");
      if (before.body !== issue.body) changed.push("body");
      if (before.source_state !== issue.sourceState || before.source_state_reason !== (issue.sourceStateReason ?? null)) changed.push("state");
      if (before.labels_json !== json(labels)) changed.push("labels");
      if (issue.parentId != null && before.parent_id !== issue.parentId) changed.push("parent");
      if (issue.acceptedTextAt != null && before.accepted_text_at !== issue.acceptedTextAt) changed.push("acceptedText");
      if (changed.length > 0) this.#events.append("item.updated", { number: issue.sourceNumber, changed }, scope);
    }
    if (issue.issueType !== undefined) this.setIssueMetadata(issue.id, { type: issue.issueType });
  }

  /** Merge a type and/or field values into the stored metadata; fields not named are kept. */
  setIssueMetadata(issueId: string, update: { type?: string | null; fields?: Record<string, string>; fieldsSyncedAt?: string }): void {
    const row = this.#database.query("SELECT metadata_json FROM issues WHERE id = ?").get(issueId) as
      { metadata_json: string | null } | null;
    if (!row) return;
    const current = parseMetadata(row.metadata_json);
    const next: IssueMetadata = {
      type: update.type !== undefined ? update.type : current.type,
      // A read from GitHub (marked by fieldsSyncedAt) replaces the stored values; a write merges.
      fields: update.fieldsSyncedAt !== undefined ? { ...(update.fields ?? {}) } : { ...current.fields, ...(update.fields ?? {}) },
    };
    const syncedAt = update.fieldsSyncedAt ?? current.fieldsSyncedAt;
    if (syncedAt !== undefined) next.fieldsSyncedAt = syncedAt;
    if (json(next) === json(current)) return;
    this.#database.transaction(() => {
      this.#database.query("UPDATE issues SET metadata_json = ? WHERE id = ?").run(json(next), issueId);
      // A read that finds the same values only moves its sync time; that is not a change.
      if (next.type !== current.type || json(next.fields) !== json(current.fields)) this.#events.append("item.metadataChanged", {}, { issueId });
    })();
  }

  setQueueRank(issueId: string, rank: number): void {
    if (!Number.isFinite(rank)) throw new Error("queue rank must be finite");
    this.#database.transaction(() => {
      const changed = this.#database
        .query("UPDATE issues SET queue_rank = ?, updated_at = ? WHERE id = ? AND queue_rank IS NOT ?")
        .run(rank, now(), issueId, rank);
      if (changed.changes > 0) this.#events.append("item.queueChanged", { rank }, { issueId });
    })();
  }

  nextQueueRank(): number {
    const row = this.#database
      .query("SELECT COALESCE(MAX(queue_rank), 0) AS maximum FROM issues")
      .get() as { maximum: number };
    return Number(row.maximum) + 10;
  }

  /** A change of projected stage or state fences the item; a warning-only change does not. */
  setIssueProjection(
    issueId: string,
    projection: { stage: string | null; state: string | null; warning: string | null },
  ): void {
    this.#database.transaction(() => {
      const before = this.#database
        .query("SELECT projected_stage, projected_state FROM issues WHERE id = ?")
        .get(issueId) as { projected_stage: string | null; projected_state: string | null } | null;
      this.writeIssueProjection(issueId, projection);
      const changed = before !== null &&
        (before.projected_stage !== projection.stage || before.projected_state !== projection.state);
      if (changed) {
        this.#events.append("item.stageChanged", {
          fromStage: before.projected_stage, fromState: before.projected_state, toStage: projection.stage, toState: projection.state,
        }, { issueId });
      }
      // Waiting for an answer and resuming after it is not a stage change: while the item's step is
      // parked on a question, moving between active and needs-input in the same stage keeps the
      // step, so the answer resumes it. Any other change fences the item.
      const cursor = changed ? this.#executions.getCursor(issueId) : null;
      const questionPause = changed && before!.projected_stage === projection.stage &&
        new Set([before!.projected_state, projection.state]).size === 2 &&
        [before!.projected_state, projection.state].every((state) => state === "active" || state === "needs-input") &&
        cursor?.state === "pending" && cursor.stage === projection.stage;
      if (changed && !questionPause) {
        this.#executions.onStageChange(issueId);
        const state = projection.state;
        if (state === "done" && before!.projected_state !== "done") {
          this.recordPushEvent({ id: randomUUID(), category: "done", target: issueId });
        } else if (["blocked", "error", "needs-intervention", "rejected"].includes(state ?? "") && before!.projected_state !== state) {
          this.recordPushEvent({ id: randomUUID(), category: "stopped", target: issueId });
        }
      }
    })();
  }

  private writeIssueProjection(
    issueId: string,
    projection: { stage: string | null; state: string | null; warning: string | null },
  ): void {
    this.#database
      .query(
        `UPDATE issues
         SET projected_stage = ?, projected_state = ?, warning = ?, updated_at = ?
         WHERE id = ? AND (
           projected_stage IS NOT ? OR projected_state IS NOT ? OR warning IS NOT ?
         )`,
      )
      .run(
        projection.stage,
        projection.state,
        projection.warning,
        now(),
        issueId,
        projection.stage,
        projection.state,
        projection.warning,
      );
  }

  getIssue(issueId: string): StoredIssue | null {
    const row = this.#database
      .query("SELECT * FROM issues WHERE id = ?")
      .get(issueId) as Record<string, SQLQueryBindings> | null;
    if (!row) return null;
    return this.mapIssue(row);
  }

  listIssues(repositoryId?: string): StoredIssue[] {
    const rows = (repositoryId
      ? this.#database
          .query(
            `SELECT * FROM issues WHERE repository_id = ?
             ORDER BY queue_rank IS NULL, queue_rank, source_number`,
          )
          .all(repositoryId)
      : this.#database
          .query(
            `SELECT * FROM issues
             ORDER BY queue_rank IS NULL, queue_rank, repository_id, source_number`,
          )
          .all()) as Array<Record<string, SQLQueryBindings>>;
    return rows.map((row) => this.mapIssue(row));
  }

  /**
   * Returns durable activity ordered by its event time and a source-prefixed ID. A Done push event
   * is the source of truth for a completion; only legacy done items without one use merged_at.
   */
  listRecentActivity(input: {
    from: string | null;
    before: { occurredAt: string; id: string | null } | null;
    limit: number;
    repositoryIds?: readonly string[];
  }): StoredRecentActivity[] {
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit)));
    const before = input.before;
    const repositoryIds = [...new Set(input.repositoryIds ?? [])];
    const repositoryFilter = repositoryIds.length === 0
      ? ""
      : ` AND i.repository_id IN (${repositoryIds.map(() => "?").join(", ")})`;
    const bindings: SQLQueryBindings[] = [
      input.from,
      input.from,
      before?.occurredAt ?? null,
      before?.occurredAt ?? null,
      before?.occurredAt ?? null,
      before?.id ?? null,
      before?.id ?? null,
    ];
    const page = (rows: Array<Record<string, SQLQueryBindings>>) => rows.map((row) => this.mapRecentActivity(row));
    const transitionRows = this.#database.query(
      `SELECT 'transition' AS source, 'transition:' || st.id AS id, st.issue_id AS issue_id,
              i.repository_id AS repository_id, i.source_number AS issue_number, i.title AS issue_title,
              st.created_at AS occurred_at, st.from_stage AS from_stage, st.to_stage AS to_stage,
              st.kind AS kind, st.detail_json AS detail_json
         FROM stage_transitions AS st INDEXED BY stage_transitions_created_at_idx
         JOIN issues AS i ON i.id = st.issue_id
        WHERE st.status = 'completed'
          AND COALESCE(i.projected_state, '') <> 'offboarded'
          AND (? IS NULL OR st.created_at >= ?)
          AND (? IS NULL OR st.created_at < ? OR (st.created_at = ? AND (? IS NOT NULL AND ('transition:' || st.id) < ?)))
          ${repositoryFilter}
        ORDER BY st.created_at DESC, st.id DESC
        LIMIT ?`,
    ).all(...bindings, ...repositoryIds, limit) as Array<Record<string, SQLQueryBindings>>;
    const doneRows = this.#database.query(
      `SELECT 'done' AS source, 'done:' || p.id AS id, i.id AS issue_id,
              i.repository_id AS repository_id, i.source_number AS issue_number, i.title AS issue_title,
              p.created_at AS occurred_at, NULL AS from_stage, NULL AS to_stage, 'done' AS kind, NULL AS detail_json
         FROM push_events AS p INDEXED BY push_events_done_created_at_idx
         JOIN issues AS i ON i.id = p.target
        WHERE p.category = 'done'
          AND COALESCE(i.projected_state, '') <> 'offboarded'
          AND (? IS NULL OR p.created_at >= ?)
          AND (? IS NULL OR p.created_at < ? OR (p.created_at = ? AND (? IS NOT NULL AND ('done:' || p.id) < ?)))
          ${repositoryFilter}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ?`,
    ).all(...bindings, ...repositoryIds, limit) as Array<Record<string, SQLQueryBindings>>;
    const fallbackRows = this.#database.query(
      `WITH legacy_done AS (
         SELECT 'done-fallback' AS source, 'done:fallback:' || i.id AS id, i.id AS issue_id,
                i.repository_id AS repository_id, i.source_number AS issue_number, i.title AS issue_title,
                pr.merged_at AS occurred_at, NULL AS from_stage, NULL AS to_stage, 'done' AS kind, NULL AS detail_json
           FROM pull_requests AS pr INDEXED BY pull_requests_merged_at_idx
           JOIN enrollments AS e ON e.id = pr.enrollment_id
           JOIN issues AS i ON i.id = e.issue_id
          WHERE i.projected_state IN ('done', 'completed')
            AND COALESCE(i.projected_state, '') <> 'offboarded'
            AND pr.merged_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM push_events AS p WHERE p.category = 'done' AND p.target = i.id)
            AND NOT EXISTS (
              SELECT 1
                FROM enrollments AS newer_enrollment INDEXED BY enrollments_issue_id_idx
                JOIN pull_requests AS newer_pull_request INDEXED BY pull_requests_enrollment_merged_at_idx
                  ON newer_pull_request.enrollment_id = newer_enrollment.id
               WHERE newer_enrollment.issue_id = i.id
                 AND newer_pull_request.merged_at IS NOT NULL
                 AND (newer_pull_request.merged_at > pr.merged_at
                   OR (newer_pull_request.merged_at = pr.merged_at AND newer_pull_request.id > pr.id))
            )
            AND (? IS NULL OR pr.merged_at >= ?)
            AND (? IS NULL OR pr.merged_at < ? OR (pr.merged_at = ? AND (? IS NOT NULL AND ('done:fallback:' || i.id) < ?)))
            ${repositoryFilter}
       )
       SELECT * FROM legacy_done
        ORDER BY occurred_at DESC, id DESC
        LIMIT ?`,
    ).all(...bindings, ...repositoryIds, limit) as Array<Record<string, SQLQueryBindings>>;
    return page([...transitionRows, ...doneRows, ...fallbackRows])
      // SQLite compares these cursor keys with its binary collation. Keep the in-memory merge
      // identical so a timestamp tie cannot be reordered between one page and the next.
      .sort((left, right) => left.occurredAt === right.occurredAt
        ? left.id === right.id ? 0 : left.id > right.id ? -1 : 1
        : left.occurredAt > right.occurredAt ? -1 : 1)
      .slice(0, limit);
  }

  private mapRecentActivity(row: Record<string, SQLQueryBindings>): StoredRecentActivity {
    const detail = row.detail_json === null ? {} : parseJson<Partial<StageTransitionDetail>>(String(row.detail_json)) ?? {};
    return {
      id: String(row.id),
      source: String(row.source) as StoredRecentActivity["source"],
      issueId: String(row.issue_id),
      repositoryId: String(row.repository_id),
      issueNumber: Number(row.issue_number),
      issueTitle: String(row.issue_title),
      occurredAt: String(row.occurred_at),
      fromStage: row.from_stage === null ? null : String(row.from_stage),
      toStage: row.to_stage === null ? null : String(row.to_stage),
      kind: String(row.kind),
      resultStatus: typeof detail.resultStatus === "string" ? detail.resultStatus : null,
      reason: typeof detail.reason === "string" ? detail.reason : null,
    };
  }

  /**
   * Counts all items qualifying for the dashboard's Done lane in SQLite, without mapping historic
   * issues into cards. The caller supplies the configured workflow labels because they are config,
   * not durable database state.
   */
  countFinishedIssues(query: FinishedIssueCountQuery): number {
    const bindings: SQLQueryBindings[] = [];
    const workflowClauses = query.workflows.flatMap(({ repositoryId, stages, sourceStageLabels }) => {
      if (stages.length === 0) return [];
      const stagePlaceholders = stages.map(() => "?").join(", ");
      const sourceLabelCount = sourceStageLabels.length === 0
        ? "0"
        : `(SELECT COUNT(*) FROM json_each(issues.labels_json) WHERE value IN (${sourceStageLabels.map(() => "?").join(", ")}))`;
      bindings.push(repositoryId, ...stages, ...sourceStageLabels);
      return [`(issues.repository_id = ?
        AND issues.projected_stage IN (${stagePlaceholders})
        AND COALESCE(issues.projected_state, '') NOT IN ('done', 'inconsistent')
        AND (issues.projected_state = 'active' OR ${sourceLabelCount} = 1))`];
    });
    const filters: string[] = [];
    if (query.repositoryIds.length > 0) {
      filters.push(`issues.repository_id IN (${query.repositoryIds.map(() => "?").join(", ")})`);
      bindings.push(...query.repositoryIds);
    }
    for (const word of query.words) {
      const pattern = `%${word.replace(/[\\%_]/g, "\\$&")}%`;
      const actorClauses = query.stageActors.map(({ repositoryId, stageId, text }) => {
        bindings.push(repositoryId, stageId, text, pattern);
        return "(issues.repository_id = ? AND issues.projected_stage = ? AND ? LIKE ? ESCAPE '\\')";
      });
      filters.push(`(
        LOWER(issues.title) LIKE ? ESCAPE '\\' OR
        LOWER(CAST(issues.source_number AS TEXT)) LIKE ? ESCAPE '\\' OR
        LOWER('#' || issues.source_number) LIKE ? ESCAPE '\\' OR
        LOWER(issues.repository_id) LIKE ? ESCAPE '\\' OR
        LOWER(issues.labels_json) LIKE ? ESCAPE '\\' OR
        LOWER(COALESCE(issues.metadata_json, '')) LIKE ? ESCAPE '\\'
        ${actorClauses.length > 0 ? `OR ${actorClauses.join(" OR ")}` : ""}
      )`);
      // Keep the six ordinary search fields ahead of the stage-specific actor clauses above.
      bindings.splice(bindings.length - actorClauses.length * 4, 0, pattern, pattern, pattern, pattern, pattern, pattern);
    }
    const workflow = workflowClauses.length > 0 ? workflowClauses.join(" OR ") : "0";
    const row = this.#database.query(`
      SELECT COUNT(*) AS count
      FROM issues
      WHERE (
        (issues.source_state = 'closed' AND NOT (${workflow})) OR
        (issues.projected_state IN ('done', 'completed') AND EXISTS (
          SELECT 1 FROM issue_relationships WHERE parent_id = issues.id
        ))
      )
      AND COALESCE(issues.projected_state, '') <> 'offboarded'
      ${filters.length > 0 ? `AND ${filters.join(" AND ")}` : ""}
    `).get(...bindings) as { count: number };
    return Number(row.count);
  }

  replaceRelationships(
    issueId: string,
    parent: { parentId: string; siblingOrder: number | null } | null,
    blockers: readonly string[],
  ): void {
    this.#database.transaction(() => {
      const normalizedBlockers = [...new Set(blockers)].sort((left, right) => left.localeCompare(right));
      if (normalizedBlockers.includes(issueId)) {
        throw new Error("an issue cannot depend on itself");
      }
      const currentParent = this.#database
        .query(
          `SELECT parent_id, sibling_order FROM issue_relationships
           WHERE child_id = ? LIMIT 1`,
        )
        .get(issueId) as { parent_id: string; sibling_order: number | null } | null;
      const currentBlockers = (this.#database
        .query("SELECT blocker_id FROM dependencies WHERE issue_id = ? ORDER BY blocker_id")
        .all(issueId) as Array<{ blocker_id: string }>)
        .map((row) => row.blocker_id);
      const sameParent = parent
        ? currentParent?.parent_id === parent.parentId && currentParent.sibling_order === parent.siblingOrder
        : currentParent === null;
      const sameBlockers = currentBlockers.length === normalizedBlockers.length &&
        currentBlockers.every((blockerId, index) => blockerId === normalizedBlockers[index]);
      if (sameParent && sameBlockers) return;

      this.#database
        .query("DELETE FROM issue_relationships WHERE child_id = ?")
        .run(issueId);
      this.#database.query("DELETE FROM dependencies WHERE issue_id = ?").run(issueId);
      this.#database
        .query("UPDATE issues SET parent_id = ?, updated_at = ? WHERE id = ?")
        .run(parent?.parentId ?? null, now(), issueId);
      if (parent) {
        this.#database
          .query(
            `INSERT INTO issue_relationships(parent_id, child_id, sibling_order)
             VALUES (?, ?, ?)`,
          )
          .run(parent.parentId, issueId, parent.siblingOrder);
      }
      const insertDependency = this.#database.query(
        "INSERT INTO dependencies(issue_id, blocker_id) VALUES (?, ?)",
      );
      for (const blockerId of normalizedBlockers) {
        insertDependency.run(issueId, blockerId);
      }
      this.#events.append("item.relationshipsChanged", { parentId: parent?.parentId ?? null, dependencies: normalizedBlockers }, { issueId });
    })();
  }

  listDependencies(issueId: string): string[] {
    const rows = this.#database
      .query(
        "SELECT blocker_id FROM dependencies WHERE issue_id = ? ORDER BY blocker_id",
      )
      .all(issueId) as Array<{ blocker_id: string }>;
    return rows.map((row) => row.blocker_id);
  }

  listDependents(blockerId: string): string[] {
    const rows = this.#database
      .query(
        "SELECT issue_id FROM dependencies WHERE blocker_id = ? ORDER BY issue_id",
      )
      .all(blockerId) as Array<{ issue_id: string }>;
    return rows.map((row) => row.issue_id);
  }

  listChildren(parentId: string): Array<{
    issueId: string;
    siblingOrder: number | null;
  }> {
    const rows = this.#database
      .query(
        `SELECT child_id, sibling_order FROM issue_relationships
         WHERE parent_id = ? ORDER BY sibling_order IS NULL, sibling_order, child_id`,
      )
      .all(parentId) as Array<{ child_id: string; sibling_order: number | null }>;
    return rows.map((row) => ({
      issueId: row.child_id,
      siblingOrder: row.sibling_order,
    }));
  }

  activateEnrollment(issueId: string): EnrollmentRecord {
    return this.#database.transaction(() => {
      const active = this.#database
        .query(
          `SELECT * FROM enrollments
           WHERE issue_id = ? AND status = 'active'
           ORDER BY generation DESC LIMIT 1`,
        )
        .get(issueId) as Record<string, SQLQueryBindings> | null;
      if (active) return this.mapEnrollment(active);
      this.#executions.onStageChange(issueId);

      const latest = this.#database
        .query(
          "SELECT COALESCE(MAX(generation), 0) AS generation FROM enrollments WHERE issue_id = ?",
        )
        .get(issueId) as { generation: number };
      const id = randomUUID();
      const startedAt = now();
      this.#database
        .query(
          `INSERT INTO enrollments(id, issue_id, generation, status, started_at)
           VALUES (?, ?, ?, 'active', ?)`,
        )
        .run(id, issueId, Number(latest.generation) + 1, startedAt);
      this.#events.append("item.enrolled", { generation: Number(latest.generation) + 1 }, { issueId });
      return this.getEnrollment(id)!;
    })();
  }

  getEnrollment(id: string): EnrollmentRecord | null {
    const row = this.#database
      .query("SELECT * FROM enrollments WHERE id = ?")
      .get(id) as Record<string, SQLQueryBindings> | null;
    return row ? this.mapEnrollment(row) : null;
  }

  endActiveEnrollment(issueId: string, status: string): void {
    const timestamp = now();
    this.#database.transaction(() => {
      this.#database
        .query(
          `UPDATE workspaces SET status = 'stale'
           WHERE enrollment_id IN (
             SELECT id FROM enrollments WHERE issue_id = ? AND status = 'active'
           ) AND status = 'active'`,
        )
        .run(issueId);
      const ended = this.#database
        .query(
          `UPDATE enrollments SET status = ?, ended_at = ?
           WHERE issue_id = ? AND status = 'active'`,
        )
        .run(status, timestamp, issueId);
      if (ended.changes > 0) {
        this.#executions.onStageChange(issueId);
        this.#events.append("item.offboarded", { status }, { issueId });
      }
    })();
  }

  recordWorkspace(workspace: {
    id: string;
    enrollmentId: string;
    path: string;
    branch: string;
    status: string;
  }): void {
    this.#database.transaction(() => {
      const before = this.#database.query("SELECT status FROM workspaces WHERE id = ?").get(workspace.id) as { status: string } | null;
      this.#database
        .query(
          `INSERT INTO workspaces(id, enrollment_id, path, branch, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = excluded.status`,
        )
        .run(
          workspace.id,
          workspace.enrollmentId,
          workspace.path,
          workspace.branch,
          workspace.status,
          now(),
        );
      if (before?.status !== workspace.status) {
        this.#events.append("workspace.recorded", { branch: workspace.branch, status: workspace.status }, { issueId: this.#enrollmentIssue(workspace.enrollmentId) });
      }
    })();
  }

  #enrollmentIssue(enrollmentId: string): string | null {
    const row = this.#database.query("SELECT issue_id FROM enrollments WHERE id = ?").get(enrollmentId) as { issue_id: string } | null;
    return row?.issue_id ?? null;
  }

  getActiveWorkspace(issueId: string): StoredWorkspace | null {
    const row = this.#database
      .query(
        `SELECT w.*, e.issue_id, e.generation
         FROM workspaces w
         JOIN enrollments e ON e.id = w.enrollment_id
         WHERE e.issue_id = ? AND e.status = 'active' AND w.status = 'active'
         ORDER BY e.generation DESC LIMIT 1`,
      )
      .get(issueId) as Record<string, SQLQueryBindings> | null;
    if (!row) return null;
    return {
      id: String(row.id),
      enrollmentId: String(row.enrollment_id),
      issueId: String(row.issue_id),
      generation: Number(row.generation),
      path: String(row.path),
      branch: String(row.branch),
      status: String(row.status),
    };
  }

  listActiveWorkspaces(): StoredWorkspace[] {
    const rows = this.#database
      .query(
        `SELECT w.*, e.issue_id, e.generation
         FROM workspaces w
         JOIN enrollments e ON e.id = w.enrollment_id
         WHERE e.status = 'active' AND w.status = 'active'
         ORDER BY e.generation DESC`,
      )
      .all() as Record<string, SQLQueryBindings>[];
    return rows.map((row) => ({
      id: String(row.id),
      enrollmentId: String(row.enrollment_id),
      issueId: String(row.issue_id),
      generation: Number(row.generation),
      path: String(row.path),
      branch: String(row.branch),
      status: String(row.status),
    }));
  }

  markWorkspaceRemoved(workspaceId: string): void {
    this.#database.transaction(() => {
      const removed = this.#database
        .query(
          `UPDATE workspaces SET status = 'removed', removed_at = ? WHERE id = ? AND status <> 'removed'`,
        )
        .run(now(), workspaceId);
      if (removed.changes === 0) return;
      const row = this.#database.query("SELECT enrollment_id FROM workspaces WHERE id = ?").get(workspaceId) as { enrollment_id: string } | null;
      this.#events.append("workspace.removed", {}, { issueId: row ? this.#enrollmentIssue(row.enrollment_id) : null });
    })();
  }

  upsertPullRequest(input: {
    issueId: string;
    id: string;
    number: number;
    url: string;
    state: string;
    mergedAt?: string | null;
  }): void {
    const enrollment = this.#database
      .query(
        `SELECT id FROM enrollments WHERE issue_id = ? AND status = 'active'
         ORDER BY generation DESC LIMIT 1`,
      )
      .get(input.issueId) as { id: string } | null;
    if (!enrollment) throw new Error(`issue ${input.issueId} has no active enrollment`);
    const before = this.#database.query("SELECT state, merged_at FROM pull_requests WHERE id = ?").get(input.id) as { state: string; merged_at: string | null } | null;
    this.#database.transaction(() => {
      this.#database
      .query(
        `INSERT INTO pull_requests(
           id, enrollment_id, source_number, url, state, merged_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           state = excluded.state,
           merged_at = COALESCE(excluded.merged_at, pull_requests.merged_at),
           updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        enrollment.id,
        input.number,
        input.url,
        input.state,
        input.mergedAt ?? null,
        now(),
      );
      const merged = before?.merged_at == null && input.mergedAt != null;
      if (!before) this.#events.append("change.opened", { number: input.number, state: input.state }, { issueId: input.issueId });
      else if (before.state !== input.state || merged) this.#events.append("change.stateChanged", { number: input.number, state: merged ? "merged" : input.state }, { issueId: input.issueId });
    })();
  }

  getCurrentPullRequest(issueId: string): StoredPullRequest | null {
    const row = this.#database
      .query(
        `SELECT p.*, e.issue_id
         FROM pull_requests p
         JOIN enrollments e ON e.id = p.enrollment_id
         WHERE e.issue_id = ? AND e.status = 'active'
         ORDER BY p.updated_at DESC, p.id DESC LIMIT 1`,
      )
      .get(issueId) as Record<string, SQLQueryBindings> | null;
    if (!row) return null;
    return {
      id: String(row.id),
      issueId: String(row.issue_id),
      number: Number(row.source_number),
      url: String(row.url),
      state: String(row.state),
      mergedAt: row.merged_at === null ? null : String(row.merged_at),
      updatedAt: String(row.updated_at),
    };
  }

  /** The items of a repository whose current pull request is `number`. */
  findIssueIdsByPullRequest(repositoryId: string, number: number): string[] {
    const rows = this.#database
      .query(
        `SELECT DISTINCT i.id FROM pull_requests p
         JOIN enrollments e ON e.id = p.enrollment_id AND e.status = 'active'
         JOIN issues i ON i.id = e.issue_id
         WHERE i.repository_id = ? AND p.source_number = ?`,
      )
      .all(repositoryId, number) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /** The items of a repository whose stored indicator `indicatorId` is for `headSha`. */
  findIssueIdsByIndicatorHead(repositoryId: string, indicatorId: string, headSha: string): string[] {
    const rows = this.#database
      .query(
        `SELECT n.issue_id AS id FROM item_indicators n JOIN issues i ON i.id = n.issue_id
         WHERE i.repository_id = ? AND n.indicator_id = ? AND n.head_sha = ?`,
      )
      .all(repositoryId, indicatorId, headSha) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  hasMergedPullRequest(issueId: string): boolean {
    const row = this.#database
      .query(
        `SELECT 1 AS found FROM pull_requests p
         JOIN enrollments e ON e.id = p.enrollment_id
         WHERE e.issue_id = ? AND p.merged_at IS NOT NULL LIMIT 1`,
      )
      .get(issueId) as { found: number } | null;
    return row?.found === 1;
  }

  /**
   * Fences the item when the stage changes, or the status changes into anything other than
   * the executor's own bookkeeping statuses (ready, running, error, interrupted).
   */
  setStageState(state: {
    issueId: string;
    stageId: string;
    status: string;
    feedbackCycle: number;
    configHash: string;
  }): void {
    this.#database.transaction(() => {
      const before = this.getStageState(state.issueId);
      this.writeStageState(state);
      const stageChanged = before?.stageId !== state.stageId;
      const statusChanged = before?.status !== state.status;
      if (stageChanged || (statusChanged && !EXECUTOR_STATUSES.has(state.status))) {
        this.#executions.onStageChange(state.issueId);
      }
    })();
  }

  /** Marks a stage as owned by its current execution epoch and returns that ownership token. */
  claimStageExecution(state: {
    issueId: string;
    stageId: string;
    feedbackCycle: number;
    configHash: string;
  }): number {
    return this.#database.transaction(() => {
      const stageEpoch = this.#executions.stageEpoch(state.issueId);
      this.writeStageState({ ...state, status: "running", executionEpoch: stageEpoch });
      return stageEpoch;
    })();
  }

  /**
   * Releases a running stage after its executor was fenced. The epoch token prevents an older
   * executor from clearing a stage that a newer executor, cursor, or projection now owns.
   */
  releaseFencedStageExecution(input: { issueId: string; stageId: string; stageEpoch: number }): boolean {
    return this.#database.transaction(() => {
      const owned = this.#database
        .query(
          `SELECT stage_id, status, feedback_cycle, config_hash, execution_epoch
           FROM stage_states WHERE issue_id = ?`,
        )
        .get(input.issueId) as {
          stage_id: string;
          status: string;
          feedback_cycle: number;
          config_hash: string;
          execution_epoch: number | null;
        } | null;
      if (
        !owned
        || owned.stage_id !== input.stageId
        || owned.status !== "running"
        || owned.execution_epoch !== input.stageEpoch
      ) return false;

      const cursor = this.#executions.getCursor(input.issueId);
      if (cursor) return false;

      const issue = this.getIssue(input.issueId);
      if (!issue) return false;
      this.writeStageState({
        issueId: input.issueId,
        stageId: issue.projectedStage ?? input.stageId,
        status: "ready",
        feedbackCycle: owned.feedback_cycle,
        configHash: owned.config_hash,
        executionEpoch: null,
      });
      return true;
    })();
  }

  private writeStageState(state: {
    issueId: string;
    stageId: string;
    status: string;
    feedbackCycle: number;
    configHash: string;
    executionEpoch?: number | null;
  }): void {
    const executionEpoch = state.executionEpoch ?? null;
    const before = this.#database
      .query("SELECT stage_id, status, feedback_cycle FROM stage_states WHERE issue_id = ?")
      .get(state.issueId) as { stage_id: string; status: string; feedback_cycle: number } | null;
    this.#database
      .query(
        `INSERT INTO stage_states(
           issue_id, stage_id, status, feedback_cycle, config_hash, execution_epoch, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(issue_id) DO UPDATE SET
           stage_id = excluded.stage_id,
           status = excluded.status,
           feedback_cycle = excluded.feedback_cycle,
           config_hash = excluded.config_hash,
           execution_epoch = excluded.execution_epoch,
           updated_at = CASE WHEN
             stage_states.stage_id IS NOT excluded.stage_id OR
             stage_states.status IS NOT excluded.status OR
             stage_states.feedback_cycle IS NOT excluded.feedback_cycle OR
             stage_states.config_hash IS NOT excluded.config_hash OR
             stage_states.execution_epoch IS NOT excluded.execution_epoch
           THEN excluded.updated_at ELSE stage_states.updated_at END`,
      )
      .run(
        state.issueId,
        state.stageId,
        state.status,
        state.feedbackCycle,
        state.configHash,
        executionEpoch,
        now(),
      );
    if (before?.stage_id !== state.stageId || before.status !== state.status || before.feedback_cycle !== state.feedbackCycle) {
      this.#events.append("stage.stateChanged", { stageId: state.stageId, status: state.status, feedbackCycle: state.feedbackCycle }, { issueId: state.issueId });
    }
  }

  getStageState(issueId: string): StoredStageState | null {
    const row = this.#database
      .query("SELECT * FROM stage_states WHERE issue_id = ?")
      .get(issueId) as Record<string, SQLQueryBindings> | null;
    if (!row) return null;
    return {
      issueId: String(row.issue_id),
      stageId: String(row.stage_id),
      status: String(row.status),
      feedbackCycle: Number(row.feedback_cycle),
      configHash: String(row.config_hash),
      updatedAt: String(row.updated_at),
    };
  }

  /** A completed journey entry that is not a label transition Conveyor applied (a resume, a restart). */
  recordJourneyEvent(input: { issueId: string; stage: string | null; kind: string; reason: string }): void {
    const id = randomUUID();
    this.beginStageTransition({
      id, issueId: input.issueId, fromStage: input.stage, toStage: input.stage, kind: input.kind, sourceMutationId: null,
      detail: { reason: input.reason, requiredFixes: [], resultStatus: null, actor: { name: "Conveyor", title: "Orchestrator" } },
    });
    this.completeStageTransition(id);
  }

  beginStageTransition(input: {
    id: string;
    issueId: string;
    fromStage: string | null;
    toStage: string | null;
    kind: string;
    sourceMutationId: string | null;
    detail: StageTransitionDetail;
  }): void {
    this.#database
      .query(
        `INSERT INTO stage_transitions(
           id, issue_id, from_stage, to_stage, status, source_mutation_id,
           created_at, completed_at, kind, detail_json
         ) VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        input.id,
        input.issueId,
        input.fromStage,
        input.toStage,
        input.sourceMutationId,
        now(),
        input.kind,
        json(input.detail),
      );
  }

  completeStageTransition(id: string): void {
    this.#database.transaction(() => {
      const ended = this.#database
        .query(
          `UPDATE stage_transitions
           SET status = 'completed', completed_at = ?
           WHERE id = ? AND status <> 'completed'`,
        )
        .run(now(), id);
      if (ended.changes > 0) this.#appendJourney(id, "completed");
    })();
  }

  failStageTransition(id: string): void {
    this.#database.transaction(() => {
      const ended = this.#database
        .query(
          `UPDATE stage_transitions
           SET status = 'failed', completed_at = ?
           WHERE id = ? AND status <> 'completed' AND status <> 'failed'`,
        )
        .run(now(), id);
      if (ended.changes > 0) this.#appendJourney(id, "failed");
    })();
  }

  #appendJourney(id: string, status: "completed" | "failed"): void {
    const row = this.#database
      .query("SELECT issue_id, kind, from_stage, to_stage FROM stage_transitions WHERE id = ?")
      .get(id) as { issue_id: string; kind: string; from_stage: string | null; to_stage: string | null } | null;
    if (!row) return;
    this.#events.append("journey.recorded", { transitionId: id, kind: row.kind, fromStage: row.from_stage, toStage: row.to_stage, status }, { issueId: row.issue_id });
  }

  listStageTransitions(issueId: string): StoredStageTransition[] {
    const rows = this.#database
      .query(
        `SELECT st.*, sm.error AS source_error
         FROM stage_transitions st
         LEFT JOIN source_mutations sm ON sm.id = st.source_mutation_id
         WHERE st.issue_id = ?
         ORDER BY st.created_at, st.id`,
      )
      .all(issueId) as Array<Record<string, SQLQueryBindings>>;
    return rows.map((row) => {
      const detail = parseJson<Partial<StageTransitionDetail>>(String(row.detail_json)) ?? {};
      return {
        id: String(row.id),
        issueId: String(row.issue_id),
        fromStage: row.from_stage === null ? null : String(row.from_stage),
        toStage: row.to_stage === null ? null : String(row.to_stage),
        kind: String(row.kind),
        status: String(row.status),
        sourceMutationId:
          row.source_mutation_id === null ? null : String(row.source_mutation_id),
        error: row.source_error === null ? null : String(row.source_error),
        reason: typeof detail.reason === "string" ? detail.reason : null,
        requiredFixes: Array.isArray(detail.requiredFixes)
          ? detail.requiredFixes.filter((value): value is string => typeof value === "string")
          : [],
        resultStatus:
          typeof detail.resultStatus === "string" ? detail.resultStatus : null,
        actor:
          detail.actor && typeof detail.actor.name === "string"
            ? {
                name: detail.actor.name,
                title: typeof detail.actor.title === "string" ? detail.actor.title : null,
              }
            : null,
        sourceSnapshot:
          detail.sourceSnapshot &&
          typeof detail.sourceSnapshot.title === "string" &&
          typeof detail.sourceSnapshot.body === "string"
            ? { title: detail.sourceSnapshot.title, body: detail.sourceSnapshot.body }
            : null,
        createdAt: String(row.created_at),
        completedAt: row.completed_at === null ? null : String(row.completed_at),
      };
    });
  }

  private mapEnrollment(row: Record<string, SQLQueryBindings>): EnrollmentRecord {
    return {
      id: String(row.id),
      issueId: String(row.issue_id),
      generation: Number(row.generation),
      status: String(row.status),
      startedAt: String(row.started_at),
      endedAt: row.ended_at === null ? null : String(row.ended_at),
    };
  }

  private mapIssue(row: Record<string, SQLQueryBindings>): StoredIssue {
    return {
      id: String(row.id),
      repositoryId: String(row.repository_id),
      sourceNumber: Number(row.source_number),
      sourceUrl: String(row.source_url),
      title: String(row.title),
      body: String(row.body),
      sourceState: String(row.source_state),
      sourceStateReason:
        row.source_state_reason === null ? null : String(row.source_state_reason),
      labels: parseJson<string[]>(String(row.labels_json)) ?? [],
      metadata: parseMetadata(row.metadata_json === null ? null : String(row.metadata_json)),
      sourceUpdatedAt: String(row.source_updated_at),
      acceptedTextAt: row.accepted_text_at === null ? null : String(row.accepted_text_at),
      parentId: row.parent_id === null ? null : String(row.parent_id),
      queueRank: row.queue_rank === null ? null : Number(row.queue_rank),
      projectedStage:
        row.projected_stage === null ? null : String(row.projected_stage),
      projectedState:
        row.projected_state === null ? null : String(row.projected_state),
      warning: row.warning === null ? null : String(row.warning),
    };
  }

  recordSourceEvent(event: {
    source: string;
    deliveryId: string;
    eventType: string;
    payload: unknown;
    /** The configured repository the delivery is for, when it is for one. */
    repositoryId?: string | null;
    /** What the delivery means for Conveyor, recorded with it; absent when nothing reacts to it. */
    normalized?: NormalizedGitHubEvent | null;
  }): boolean {
    return this.#database.transaction(() => {
      const result = this.#database
        .query(
          `INSERT INTO source_events(source, delivery_id, event_type, payload_json, received_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(source, delivery_id) DO NOTHING`,
        )
        .run(event.source, event.deliveryId, event.eventType, json(event.payload), now());
      if (result.changes !== 1) return false;
      const scope = { repositoryId: event.repositoryId ?? null };
      this.#events.append("webhook.received", { deliveryId: event.deliveryId, eventType: event.eventType }, scope);
      const normalized = event.normalized;
      if (normalized) this.#appendGitHubEvent(normalized, scope);
      return true;
    })();
  }

  #appendGitHubEvent(event: NormalizedGitHubEvent, scope: { repositoryId: string | null }): void {
    // Each branch narrows the payload to its own type.
    switch (event.type) {
      case "github.issueUpdated": return this.#events.append(event.type, event.payload, scope);
      case "github.relationshipChanged": return this.#events.append(event.type, event.payload, scope);
      case "github.changeUpdated": return this.#events.append(event.type, event.payload, scope);
      case "github.ciUpdated": return this.#events.append(event.type, event.payload, scope);
      case "github.ping": return this.#events.append(event.type, event.payload, scope);
    }
  }

  /** Whether a webhook delivery with this id was stored. */
  hasSourceEvent(source: string, deliveryId: string): boolean {
    return this.#database.query("SELECT 1 FROM source_events WHERE source = ? AND delivery_id = ?").get(source, deliveryId) !== null;
  }

  beginSourceMutation(input: {
    idempotencyKey: string;
    source: string;
    operation: string;
    request: unknown;
  }): SourceMutation {
    const existing = this.getSourceMutationByKey(input.idempotencyKey);
    if (existing) return existing;
    const id = randomUUID();
    const timestamp = now();
    this.#database.transaction(() => {
      this.#database
        .query(
          `INSERT INTO source_mutations(
             id, idempotency_key, source, operation, status, request_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          id,
          input.idempotencyKey,
          input.source,
          input.operation,
          json(input.request),
          timestamp,
          timestamp,
        );
      this.#events.append("source.mutationStarted", { mutationId: id, operation: input.operation });
    })();
    return this.getSourceMutation(id)!;
  }

  completeSourceMutation(id: string, response: unknown): void {
    this.#database.transaction(() => {
      const row = this.#database
        .query(
          `UPDATE source_mutations
           SET status = 'succeeded', response_json = ?, error = NULL, updated_at = ?
           WHERE id = ? RETURNING operation`,
        )
        .get(json(response), now(), id) as { operation: string } | null;
      if (row) this.#events.append("source.mutationCompleted", { mutationId: id, operation: row.operation });
    })();
  }

  failSourceMutation(id: string, error: string): void {
    this.#database.transaction(() => {
      const row = this.#database
        .query(
          `UPDATE source_mutations
           SET status = 'failed', error = ?, updated_at = ? WHERE id = ? RETURNING operation`,
        )
        .get(error, now(), id) as { operation: string } | null;
      if (row) this.#events.append("source.mutationFailed", { mutationId: id, operation: row.operation });
    })();
  }

  getSourceMutation(id: string): SourceMutation | null {
    const row = this.#database
      .query("SELECT * FROM source_mutations WHERE id = ?")
      .get(id) as Record<string, SQLQueryBindings> | null;
    return row ? this.mapSourceMutation(row) : null;
  }

  getSourceMutationByKey(key: string): SourceMutation | null {
    const row = this.#database
      .query("SELECT * FROM source_mutations WHERE idempotency_key = ?")
      .get(key) as Record<string, SQLQueryBindings> | null;
    return row ? this.mapSourceMutation(row) : null;
  }

  /** Returns the newest mutation in a family of durable external operations. */
  getLatestSourceMutationByKeyPrefix(prefix: string): SourceMutation | null {
    const escapedPrefix = prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    const row = this.#database
      .query(
        `SELECT * FROM source_mutations
         WHERE idempotency_key LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(`${escapedPrefix}%`) as Record<string, SQLQueryBindings> | null;
    return row ? this.mapSourceMutation(row) : null;
  }

  private mapSourceMutation(row: Record<string, SQLQueryBindings>): SourceMutation {
    return {
      id: String(row.id),
      idempotencyKey: String(row.idempotency_key),
      source: String(row.source),
      operation: String(row.operation),
      status: String(row.status),
      request: parseJson(String(row.request_json)),
      response:
        row.response_json === null ? null : parseJson(String(row.response_json)),
      error: row.error === null ? null : String(row.error),
    };
  }

  createRun(run: RunRecordInput): void {
    this.#database.transaction(() => {
      this.#database
        .query(
          `INSERT INTO runs(
             id, issue_id, stage_id, attempt, kind, status, config_hash, started_at, heartbeat_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.issueId,
          run.stageId,
          run.attempt,
          run.kind,
          run.status,
          run.configHash,
          run.startedAt,
          run.startedAt,
        );
      this.#events.append("run.started", { runId: run.id, kind: run.kind, stage: run.stageId }, { issueId: run.issueId });
    })();
  }

  recoverInterruptedExecutions(configHash: string): { runs: number; stages: number; recoveredStages: Array<{ issueId: string; stageId: string }> } {
    return this.#database.transaction(() => {
      const timestamp = now();
      const interruptedRuns = this.#database
        .query("SELECT id, issue_id, started_at FROM runs WHERE status = 'running'")
        .all() as Array<{ id: string; issue_id: string | null; started_at: string }>;
      const result = {
        reason: "Conveyor restarted before this run completed.",
      };
      for (const run of interruptedRuns) {
        const startedAt = Date.parse(run.started_at);
        const durationMs = Number.isFinite(startedAt)
          ? Math.max(0, Date.parse(timestamp) - startedAt)
          : 0;
        this.#database
          .query(
            `UPDATE runs SET status = 'interrupted', finished_at = ?, heartbeat_at = ?,
               exit_code = NULL, result_json = ? WHERE id = ?`,
          )
          .run(timestamp, timestamp, json(result), run.id);
        this.#database
          .query(
            `INSERT INTO usage_cost_entries(
               id, run_id, input_tokens, output_tokens, cached_tokens, amount,
               currency, source, duration_ms, created_at
             ) VALUES (?, ?, 0, 0, 0, 0, 'USD', 'unavailable', ?, ?)`,
          )
          .run(randomUUID(), run.id, durationMs, timestamp);
        this.#events.append("run.finished", { runId: run.id, status: "interrupted" }, { issueId: run.issue_id });
      }

      const interruptedStages = this.#database
        .query("SELECT issue_id, stage_id, feedback_cycle FROM stage_states WHERE status IN ('running', 'error', 'interrupted')")
        .all() as Array<{ issue_id: string; stage_id: string; feedback_cycle: number }>;
      // 'error' stages were waiting on an in-memory retry timer and 'interrupted' stages were
      // deliberately stopped during shutdown; neither has a live process after restart.
      this.#database
        .query(
          `UPDATE stage_states SET status = 'ready', config_hash = ?, updated_at = ?
           WHERE status IN ('running', 'error', 'interrupted')`,
        )
        .run(configHash, timestamp);
      for (const stage of interruptedStages) {
        this.#events.append("stage.stateChanged", { stageId: stage.stage_id, status: "ready", feedbackCycle: stage.feedback_cycle }, { issueId: stage.issue_id });
      }
      return {
        runs: interruptedRuns.length,
        stages: interruptedStages.length,
        recoveredStages: interruptedStages.map((stage) => ({ issueId: stage.issue_id, stageId: stage.stage_id })),
      };
    })();
  }

  nextRunAttempt(issueId: string, stageId: string, kind: string): number {
    const row = this.#database
      .query(
        `SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM runs
         WHERE issue_id = ? AND stage_id = ? AND kind = ?`,
      )
      .get(issueId, stageId, kind) as { attempt: number };
    return Number(row.attempt);
  }

  finishRun(
    runId: string,
    finish: {
      status: string;
      exitCode: number | null;
      result: unknown;
      sessionId: string | null;
      /** Allows deterministic imports to preserve their original completion time. */
      finishedAt?: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        cachedTokens: number;
        amount: number;
        currency: string;
        source: string;
        durationMs: number;
      };
    },
  ): void {
    this.#database.transaction(() => {
      const timestamp = finish.finishedAt ?? now();
      const updated = this.#database
        .query(
          `UPDATE runs SET status = ?, session_id = ?, finished_at = ?,
             heartbeat_at = ?, exit_code = ?, result_json = ?
           WHERE id = ?`,
        )
        .run(
          finish.status,
          finish.sessionId,
          timestamp,
          timestamp,
          finish.exitCode,
          json(finish.result),
          runId,
        );
      if (updated.changes !== 1) throw new Error(`unknown run: ${runId}`);
      this.#runProgress.forget(runId);
      const owner = this.#database.query("SELECT issue_id FROM runs WHERE id = ?").get(runId) as { issue_id: string | null } | null;
      this.#events.append("run.finished", { runId, status: finish.status }, { issueId: owner?.issue_id ?? null });
      this.#database
        .query(
          `INSERT INTO usage_cost_entries(
             id, run_id, input_tokens, output_tokens, cached_tokens, amount,
             currency, source, duration_ms, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          runId,
          finish.usage.inputTokens,
          finish.usage.outputTokens,
          finish.usage.cachedTokens,
          finish.usage.amount,
          finish.usage.currency,
          finish.usage.source,
          finish.usage.durationMs,
          timestamp,
        );
    })();
  }

  getRun(runId: string): StoredRun | null {
    const row = this.#database
      .query("SELECT * FROM runs WHERE id = ?")
      .get(runId) as Record<string, SQLQueryBindings> | null;
    if (!row) return null;
    return {
      id: String(row.id),
      issueId: row.issue_id === null ? null : String(row.issue_id),
      stageId: String(row.stage_id),
      attempt: Number(row.attempt),
      kind: String(row.kind),
      status: String(row.status),
      sessionId: row.session_id === null ? null : String(row.session_id),
      result: row.result_json === null ? null : parseJson(String(row.result_json)),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
    };
  }

  /** Records the first unreclaimed terminal home for a run and returns whether it needs a warning. */
  recordTerminalHomeReclamationFailure(runId: string): boolean {
    return this.#database
      .query("INSERT OR IGNORE INTO terminal_home_reclamation_failures(run_id, reported_at) VALUES (?, ?)")
      .run(runId, now()).changes > 0;
  }

  /** Clears the one-time warning receipt after a home is reclaimed or disappears. */
  clearTerminalHomeReclamationFailure(runId: string): void {
    this.#database.query("DELETE FROM terminal_home_reclamation_failures WHERE run_id = ?").run(runId);
  }

  /** Runs of a kind in a stage, newest first. */
  listRunsForStage(issueId: string, stageId: string, kind: string): StoredRun[] {
    const rows = this.#database
      .query("SELECT id FROM runs WHERE issue_id = ? AND stage_id = ? AND kind = ? ORDER BY started_at DESC, rowid DESC")
      .all(issueId, stageId, kind) as Array<{ id: string }>;
    return rows.map((row) => this.getRun(row.id)!);
  }

  /** Runs of a kind that logged an `execution` event with this key, newest first. */
  listRunsForExecution(issueId: string, stageId: string, kind: string, executionKey: string): StoredRun[] {
    const rows = this.#database
      .query(
        `SELECT r.id FROM runs r
         WHERE r.issue_id = ? AND r.stage_id = ? AND r.kind = ?
           AND EXISTS (
             SELECT 1 FROM run_events e
             WHERE e.run_id = r.id AND e.type = 'execution'
               AND json_extract(e.payload_json, '$.idempotencyKey') = ?
           )
         ORDER BY r.started_at DESC, r.rowid DESC`,
      )
      .all(issueId, stageId, kind, executionKey) as Array<{ id: string }>;
    return rows.map((row) => this.getRun(row.id)!);
  }

  listActiveIssueRuns(): ActiveIssueRun[] {
    const rows = this.#database
      .query(
        `SELECT * FROM (
           SELECT r.id, r.issue_id, r.stage_id, r.kind, r.started_at,
             i.repository_id, i.source_number, i.title
           FROM runs r JOIN issues i ON i.id = r.issue_id
           WHERE r.status = 'running'
           UNION ALL
           SELECT 'orchestration:' || s.issue_id || ':' || s.stage_id AS id,
             s.issue_id, s.stage_id, 'orchestration' AS kind,
             s.updated_at AS started_at, i.repository_id, i.source_number, i.title
           FROM stage_states s JOIN issues i ON i.id = s.issue_id
           WHERE s.status = 'running'
             AND NOT EXISTS (
               SELECT 1 FROM runs r
               WHERE r.issue_id = s.issue_id AND r.status = 'running'
             )
         ) ORDER BY started_at, id`,
      )
      .all() as Array<Record<string, SQLQueryBindings>>;
    return rows.map((row) => ({
      id: String(row.id),
      issueId: String(row.issue_id),
      repository: String(row.repository_id),
      issueNumber: Number(row.source_number),
      issueTitle: String(row.title),
      stageId: String(row.stage_id),
      kind: String(row.kind),
      startedAt: String(row.started_at),
    }));
  }

  listIssueRuns(issueId: string): StoredRun[] {
    const rows = this.#database
      .query(
        `SELECT * FROM runs WHERE issue_id = ?
         ORDER BY started_at DESC, id DESC`,
      )
      .all(issueId) as Array<Record<string, SQLQueryBindings>>;
    return rows.map((row) => ({
      id: String(row.id),
      issueId: String(row.issue_id),
      stageId: String(row.stage_id),
      attempt: Number(row.attempt),
      kind: String(row.kind),
      status: String(row.status),
      sessionId: row.session_id === null ? null : String(row.session_id),
      result: row.result_json === null ? null : parseJson(String(row.result_json)),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
    }));
  }

  listIssueRunsPage(
    issueId: string,
    options: { before?: string | undefined; limit: number },
  ): { runs: StoredRun[]; nextBefore: string | null } {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 20) {
      throw new Error("issue run page limit must be between 1 and 20");
    }
    let rows: Array<Record<string, SQLQueryBindings>>;
    if (options.before) {
      const cursor = this.#database
        .query("SELECT started_at, id FROM runs WHERE id = ? AND issue_id = ?")
        .get(options.before, issueId) as { started_at: string; id: string } | null;
      if (!cursor) return { runs: [], nextBefore: null };
      rows = this.#database
        .query(
          `SELECT * FROM runs WHERE issue_id = ?
           AND (started_at < ? OR (started_at = ? AND id < ?))
           ORDER BY started_at DESC, id DESC LIMIT ?`,
        )
        .all(issueId, cursor.started_at, cursor.started_at, cursor.id, options.limit + 1) as Array<Record<string, SQLQueryBindings>>;
    } else {
      rows = this.#database
        .query(
          `SELECT * FROM runs WHERE issue_id = ?
           ORDER BY started_at DESC, id DESC LIMIT ?`,
        )
        .all(issueId, options.limit + 1) as Array<Record<string, SQLQueryBindings>>;
    }
    const hasMore = rows.length > options.limit;
    const page = rows.slice(0, options.limit);
    const runs = page.map((row) => ({
      id: String(row.id),
      issueId: String(row.issue_id),
      stageId: String(row.stage_id),
      attempt: Number(row.attempt),
      kind: String(row.kind),
      status: String(row.status),
      sessionId: row.session_id === null ? null : String(row.session_id),
      result: row.result_json === null ? null : parseJson(String(row.result_json)),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
    }));
    return {
      runs,
      nextBefore: hasMore ? (runs.at(-1)?.id ?? null) : null,
    };
  }

  listRunsByKind(kind: string, limit = 10): Array<{
    id: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
  }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("run list limit must be between 1 and 100");
    }
    const rows = this.#database
      .query(
        `SELECT id, status, started_at, finished_at FROM runs
         WHERE kind = ? ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(kind, limit) as Array<Record<string, SQLQueryBindings>>;
    return rows.map((row) => ({
      id: String(row.id),
      status: String(row.status),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at),
    }));
  }

  /**
   * Stores an indicator for an item. A record for another head than the stored one replaces it only
   * when `replaceHead` says the head is the change's current one; otherwise it is stale and ignored.
   * `changed_at` (and with it the dashboard revision) moves only when what is shown changes, not
   * on every repeated observation.
   */
  saveIndicator(issueId: string, headSha: string, indicator: Indicator, replaceHead: boolean): boolean {
    const body = JSON.stringify({ entries: indicator.entries, reference: indicator.reference });
    return this.#database.transaction(() => {
      const existing = this.#database
        .query("SELECT head_sha, state, detail, progress, url, body_json, changed_at FROM item_indicators WHERE issue_id = ? AND indicator_id = ?")
        .get(issueId, indicator.id) as Record<string, string | null> | null;
      if (existing && existing.head_sha !== headSha && !replaceHead) return false;
      const same = existing !== null && existing.head_sha === headSha && existing.state === indicator.state &&
        existing.detail === indicator.detail && existing.progress === indicator.progress &&
        existing.url === indicator.url && existing.body_json === body;
      const changedAt = same ? String(existing.changed_at) : now();
      this.#database
        .query(
          `INSERT INTO item_indicators(issue_id, indicator_id, head_sha, label, state, detail, progress, url, observed_at, body_json, changed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(issue_id, indicator_id) DO UPDATE SET head_sha = excluded.head_sha, label = excluded.label,
             state = excluded.state, detail = excluded.detail, progress = excluded.progress, url = excluded.url,
             observed_at = excluded.observed_at, body_json = excluded.body_json, changed_at = excluded.changed_at`,
        )
        .run(issueId, indicator.id, headSha, indicator.label, indicator.state, indicator.detail, indicator.progress, indicator.url, indicator.observedAt, body, changedAt);
      if (!same) this.#events.append("indicator.changed", { indicatorId: indicator.id, state: indicator.state, progress: indicator.progress, headSha }, { issueId });
      return true;
    })();
  }

  listIndicators(issueId?: string): Array<StoredIndicator & { issueId: string }> {
    const rows = this.#database
      .query(`SELECT * FROM item_indicators ${issueId ? "WHERE issue_id = ?" : ""} ORDER BY issue_id, indicator_id`)
      .all(...(issueId ? [issueId] : [])) as Array<Record<string, string | null>>;
    return rows.map((row) => {
      const body = JSON.parse(String(row.body_json)) as Pick<Indicator, "entries" | "reference">;
      return {
        issueId: String(row.issue_id), id: String(row.indicator_id), headSha: String(row.head_sha), label: String(row.label),
        state: String(row.state) as Indicator["state"], detail: String(row.detail), progress: String(row.progress),
        url: row.url === null ? null : String(row.url), observedAt: String(row.observed_at), changedAt: String(row.changed_at),
        entries: body.entries, reference: body.reference,
      };
    });
  }

  clearIndicator(issueId: string, indicatorId: string): void {
    this.#database.transaction(() => {
      const removed = this.#database.query("DELETE FROM item_indicators WHERE issue_id = ? AND indicator_id = ?").run(issueId, indicatorId);
      if (removed.changes > 0) this.#events.append("indicator.cleared", { indicatorId }, { issueId });
    })();
  }

  dashboardRevision(): string {
    const rows = this.#database
      .query(
        `SELECT 'issues' AS source, COUNT(*) AS count, COALESCE(MAX(updated_at), '') AS updated FROM issues
         UNION ALL
         SELECT 'stages', COUNT(*), COALESCE(MAX(updated_at), '') FROM stage_states
         UNION ALL
         SELECT 'runs', COUNT(*), COALESCE(MAX(COALESCE(finished_at, started_at)), '') FROM runs
         UNION ALL
         SELECT 'questions', COUNT(*), COALESCE(MAX(COALESCE(answered_at, created_at)), '') FROM questions
         UNION ALL
         SELECT 'todos', COUNT(*), COALESCE(MAX(updated_at), '') FROM item_todos
         UNION ALL
         SELECT 'indicators', COUNT(*), COALESCE(MAX(changed_at), '') FROM item_indicators
         UNION ALL
         SELECT 'criterion-approvals', COUNT(*), COALESCE((
           SELECT group_concat(json_object(
             'issueId', issue_id,
             'criterionId', criterion_id,
             'reviewer', reviewer,
             'headSha', head_sha,
             'checkedAt', checked_at,
             'textHash', text_hash
           ), '|')
           FROM (SELECT * FROM criterion_approvals ORDER BY issue_id, criterion_id)
         ), '') FROM criterion_approvals
         UNION ALL
         SELECT 'criterion-evidence', COUNT(*), COALESCE((
           SELECT group_concat(json_object(
             'issueId', issue_id,
             'criterionId', criterion_id,
             'manual', manual,
             'recordedHead', recorded_head_sha,
             'sourceLinkHead', source_link_head_sha,
             'recordedAt', recorded_at
           ), '|')
           FROM (SELECT * FROM criterion_test_evidence ORDER BY issue_id, criterion_id)
         ), '') FROM criterion_test_evidence
         UNION ALL
         SELECT 'criterion-evidence-tests', COUNT(*), COALESCE((
           SELECT group_concat(json_object(
             'issueId', issue_id,
             'criterionId', criterion_id,
             'ordinal', ordinal,
             'name', name,
             'file', file,
             'line', line,
             'description', description
           ), '|')
           FROM (SELECT * FROM criterion_test_evidence_tests ORDER BY issue_id, criterion_id, ordinal)
         ), '') FROM criterion_test_evidence_tests`,
      )
      .all() as Array<Record<string, SQLQueryBindings>>;
    return rows
      .map((row) => `${String(row.source)}:${Number(row.count)}:${String(row.updated)}`)
      .join("|");
  }

  latestRunSummary(issueId: string): {
    id: string;
    status: string;
    durationMs: number | null;
    inputTokens: number;
    outputTokens: number;
    amount: number | null;
    costSource: string | null;
  } | null {
    const row = this.#database
      .query(
        `SELECT r.id, r.status, u.duration_ms, u.input_tokens, u.output_tokens,
           u.amount, u.source AS cost_source
         FROM runs r
         LEFT JOIN usage_cost_entries u ON u.run_id = r.id
         WHERE r.issue_id = ?
         ORDER BY r.started_at DESC, r.id DESC LIMIT 1`,
      )
      .get(issueId) as Record<string, SQLQueryBindings> | null;
    if (!row) return null;
    return {
      id: String(row.id),
      status: String(row.status),
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      inputTokens: row.input_tokens === null ? 0 : Number(row.input_tokens),
      outputTokens: row.output_tokens === null ? 0 : Number(row.output_tokens),
      amount: row.amount === null ? null : Number(row.amount),
      costSource: row.cost_source === null ? null : String(row.cost_source),
    };
  }

  costSummary(filters: { issueId?: string; stageId?: string } = {}): CostSummary {
    const conditions: string[] = [];
    const bindings: string[] = [];
    if (filters.issueId) {
      conditions.push("r.issue_id = ?");
      bindings.push(filters.issueId);
    }
    if (filters.stageId) {
      conditions.push("r.stage_id = ?");
      bindings.push(filters.stageId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const row = this.#database
      .query(
        `SELECT COUNT(*) AS runs, COALESCE(SUM(amount), 0) AS amount,
           COALESCE(SUM(duration_ms), 0) AS duration_ms,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
           COALESCE(SUM(CASE WHEN source = 'unavailable' THEN 1 ELSE 0 END), 0) AS unavailable_runs
         FROM usage_cost_entries u JOIN runs r ON r.id = u.run_id ${where}`,
      )
      .get(...bindings) as Record<string, SQLQueryBindings>;
    return {
      runs: Number(row.runs),
      amount: Number(row.amount),
      currency: "USD",
      durationMs: Number(row.duration_ms),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cachedTokens: Number(row.cached_tokens),
      unavailableRuns: Number(row.unavailable_runs),
    };
  }

  /** Returns every stage's usage in one query for board column summaries. */
  costSummaryByStage(): Map<string, CostSummary> {
    const rows = this.#database
      .query(
        `SELECT r.stage_id,
           COUNT(*) AS runs, COALESCE(SUM(amount), 0) AS amount,
           COALESCE(SUM(duration_ms), 0) AS duration_ms,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
           COALESCE(SUM(CASE WHEN source = 'unavailable' THEN 1 ELSE 0 END), 0) AS unavailable_runs
         FROM usage_cost_entries u JOIN runs r ON r.id = u.run_id
         GROUP BY r.stage_id`,
      )
      .all() as Array<Record<string, SQLQueryBindings>>;
    return new Map(rows.map((row) => [String(row.stage_id), {
      runs: Number(row.runs),
      amount: Number(row.amount),
      currency: "USD",
      durationMs: Number(row.duration_ms),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cachedTokens: Number(row.cached_tokens),
      unavailableRuns: Number(row.unavailable_runs),
    }]));
  }

  moveQueueIssue(issueId: string, direction: "up" | "down"): void {
    this.#database.transaction(() => {
      const issues = this.#database
        .query(
          `SELECT id, queue_rank FROM issues
           WHERE parent_id IS NULL AND queue_rank IS NOT NULL
           ORDER BY queue_rank, id`,
        )
        .all() as Array<{ id: string; queue_rank: number }>;
      const index = issues.findIndex((issue) => issue.id === issueId);
      if (index < 0) throw new Error("only queued top-level issues can be reordered");
      const otherIndex = direction === "up" ? index - 1 : index + 1;
      const current = issues[index];
      const other = issues[otherIndex];
      if (!current || !other) return;
      const timestamp = now();
      this.#database
        .query("UPDATE issues SET queue_rank = ?, updated_at = ? WHERE id = ?")
        .run(other.queue_rank, timestamp, current.id);
      this.#database
        .query("UPDATE issues SET queue_rank = ?, updated_at = ? WHERE id = ?")
        .run(current.queue_rank, timestamp, other.id);
      this.#events.append("item.queueChanged", { rank: other.queue_rank }, { issueId: current.id });
      this.#events.append("item.queueChanged", { rank: current.queue_rank }, { issueId: other.id });
    })();
  }

  /**
   * Place a queued top-level issue immediately before another one, or last when
   * `beforeIssueId` is null. Ranks are fractional, so only the moved issue is
   * rewritten; the queue is renumbered when neighbouring ranks get too close.
   */
  moveQueueIssueBefore(issueId: string, beforeIssueId: string | null): void {
    this.#database.transaction(() => {
      const load = () => this.#database
        .query(
          `SELECT id, queue_rank FROM issues
           WHERE parent_id IS NULL AND queue_rank IS NOT NULL
           ORDER BY queue_rank, id`,
        )
        .all() as Array<{ id: string; queue_rank: number }>;
      let issues = load();
      if (!issues.some((issue) => issue.id === issueId)) {
        throw new Error("only queued top-level issues can be reordered");
      }
      if (beforeIssueId === issueId) return;
      if (beforeIssueId !== null && !issues.some((issue) => issue.id === beforeIssueId)) {
        throw new Error("the target position is not a queued top-level issue");
      }
      const target = () => {
        const others = issues.filter((issue) => issue.id !== issueId);
        if (beforeIssueId === null) return (others.at(-1)?.queue_rank ?? 0) + 1;
        const index = others.findIndex((issue) => issue.id === beforeIssueId);
        const next = others[index]!.queue_rank;
        const previous = others[index - 1]?.queue_rank;
        return previous === undefined ? next - 1 : (previous + next) / 2;
      };
      let rank = target();
      const neighbours = issues.filter((issue) => issue.id !== issueId).map((issue) => issue.queue_rank);
      if (neighbours.some((value) => Math.abs(value - rank) < 1e-6)) {
        const renumber = this.#database.query("UPDATE issues SET queue_rank = ? WHERE id = ?");
        issues.forEach((issue, index) => renumber.run(index + 1, issue.id));
        issues = load();
        rank = target();
      }
      this.#database
        .query("UPDATE issues SET queue_rank = ?, updated_at = ? WHERE id = ?")
        .run(rank, now(), issueId);
      this.#events.append("item.queueChanged", { rank }, { issueId });
    })();
  }

  openQuestion(input: {
    issueId: string;
    runId: string | null;
    prompt: string;
    reason: string;
    options: unknown[];
    minSelections?: number;
    maxSelections?: number;
    allowFreeText?: boolean;
  }): StoredQuestion {
    return this.#database.transaction(() => {
      const existing = this.#database
        .query("SELECT id FROM questions WHERE issue_id = ? AND status = 'open'")
        .get(input.issueId) as { id: string } | null;
      if (existing) return this.getQuestion(existing.id)!;
      const id = randomUUID();
      this.#database
        .query(
          `INSERT INTO questions(
             id, issue_id, run_id, prompt, reason, options_json,
             min_selections, max_selections, allow_free_text, status, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        )
        .run(
          id,
          input.issueId,
          input.runId,
          input.prompt,
          input.reason,
          json(input.options),
          input.minSelections ?? 1,
          input.maxSelections ?? 1,
          input.allowFreeText ? 1 : 0,
          now(),
        );
      this.recordPushEvent({ id: `question:${id}`, category: "questions", target: input.issueId });
      this.#events.append("question.asked", { questionId: id }, { issueId: input.issueId });
      return this.getQuestion(id)!;
    })();
  }

  answerQuestion(questionId: string, source: string, answer: unknown): void {
    this.#database.transaction(() => {
      const question = this.getQuestion(questionId);
      if (!question) throw new Error(`unknown question: ${questionId}`);
      if (question.status !== "open") throw new Error("question is no longer open");
      const timestamp = now();
      this.#database
        .query(
          `INSERT INTO answers(id, question_id, source, answer_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), questionId, source, json(answer), timestamp);
      this.#database
        .query("UPDATE questions SET status = 'answered', answered_at = ? WHERE id = ?")
        .run(timestamp, questionId);
      this.#events.append("answer.recorded", { questionId }, { issueId: question.issueId });
    })();
  }

  /** Record the answer before its source mirror succeeds, keeping the question retryable. */
  recordQuestionAnswer(questionId: string, source: string, answer: unknown): void {
    this.#database.transaction(() => {
      const question = this.getQuestion(questionId);
      if (!question) throw new Error(`unknown question: ${questionId}`);
      if (question.status !== "open") throw new Error("question is no longer open");
      if (question.answer !== null) return;
      this.#database
        .query(`INSERT INTO answers(id, question_id, source, answer_json, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(randomUUID(), questionId, source, json(answer), now());
    })();
  }

  /**
   * Saves an accepted answer and the durable context an agent needs after a restart.
   * A question can contribute one answer message, so retrying an answer saved before a
   * source-label failure completes the missing message without duplicating it.
   */
  recordQuestionAnswerWithConversation(input: {
    questionId: string;
    source: string;
    answer: unknown;
    stageId: string | null;
    message: string;
    actor?: { type: "user" | "conveyor"; id: string; name: string; title: string | null };
  }): void {
    this.#database.transaction(() => {
      const question = this.getQuestion(input.questionId);
      if (!question) throw new Error(`unknown question: ${input.questionId}`);
      if (question.status !== "open") throw new Error("question is no longer open");
      const source = question.answerSource ?? input.source;
      if (question.answer === null) {
        this.#database
          .query(`INSERT INTO answers(id, question_id, source, answer_json, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run(randomUUID(), question.id, source, json(input.answer), now());
      }
      const inserted = this.#database
        .query(
          `INSERT OR IGNORE INTO conversation_messages(
             issue_id, run_id, stage_id, question_id, actor_type, actor_id, actor_name,
             actor_title, message, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          question.issueId,
          question.runId,
          input.stageId,
          question.id,
          input.actor?.type ?? "user",
          input.actor?.id ?? source,
          input.actor?.name ?? source,
          input.actor?.title ?? null,
          input.message,
          now(),
        );
      if (inserted.changes > 0) this.#events.append("message.posted", { messageId: String(inserted.lastInsertRowid), role: "user" }, { issueId: question.issueId });
    })();
  }

  completeQuestionAnswer(questionId: string): void {
    this.#database.transaction(() => {
      const row = this.#database
        .query("UPDATE questions SET status = 'answered', answered_at = ? WHERE id = ? AND status = 'open' RETURNING issue_id")
        .get(now(), questionId) as { issue_id: string } | null;
      if (row) this.#events.append("answer.recorded", { questionId }, { issueId: row.issue_id });
    })();
  }

  getQuestion(questionId: string): StoredQuestion | null {
    const row = this.#database
      .query(
        `SELECT q.*, a.answer_json, a.source AS answer_source
         FROM questions q LEFT JOIN answers a ON a.question_id = q.id
         WHERE q.id = ?`,
      )
      .get(questionId) as Record<string, SQLQueryBindings> | null;
    return row ? this.mapQuestion(row) : null;
  }

  /** The question a run opened (an issue has at most one open question at a time). */
  getQuestionForRun(runId: string): StoredQuestion | null {
    const row = this.#database
      .query(
        `SELECT q.*, a.answer_json, a.source AS answer_source
         FROM questions q LEFT JOIN answers a ON a.question_id = q.id
         WHERE q.run_id = ? ORDER BY q.created_at DESC, q.rowid DESC LIMIT 1`,
      )
      .get(runId) as Record<string, SQLQueryBindings> | null;
    return row ? this.mapQuestion(row) : null;
  }

  listOpenQuestions(): StoredQuestion[] {
    const rows = this.#database
      .query(
        `SELECT q.*, a.answer_json, a.source AS answer_source FROM questions q LEFT JOIN answers a ON a.question_id = q.id
         WHERE q.status = 'open' ORDER BY q.created_at, q.id`,
      )
      .all() as Array<Record<string, SQLQueryBindings>>;
    return rows.map((row) => this.mapQuestion(row));
  }

  /** Answered questions from prior runs of this item and stage, including pre-conversation data. */
  listAnsweredQuestionsForStage(issueId: string, stageId: string): StoredQuestion[] {
    const rows = this.#database
      .query(
        `SELECT q.*, a.answer_json, a.source AS answer_source
         FROM questions q
         JOIN runs r ON r.id = q.run_id
         JOIN answers a ON a.question_id = q.id
         WHERE q.issue_id = ? AND r.stage_id = ?
         ORDER BY q.answered_at, a.rowid`,
      )
      .all(issueId, stageId) as Array<Record<string, SQLQueryBindings>>;
    return rows.map((row) => this.mapQuestion(row));
  }

  hasQuestionForIssue(issueId: string): boolean {
    return this.#database
      .query("SELECT 1 FROM questions WHERE issue_id = ? LIMIT 1")
      .get(issueId) !== null;
  }

  private mapQuestion(row: Record<string, SQLQueryBindings>): StoredQuestion {
    return {
      id: String(row.id),
      issueId: String(row.issue_id),
      runId: row.run_id === null ? null : String(row.run_id),
      prompt: String(row.prompt),
      reason: String(row.reason),
      options: parseJson<unknown[]>(String(row.options_json)) ?? [],
      minSelections: Number(row.min_selections),
      maxSelections: Number(row.max_selections),
      allowFreeText: Number(row.allow_free_text) === 1,
      status: String(row.status),
      createdAt: String(row.created_at),
      answeredAt: row.answered_at === null ? null : String(row.answered_at),
      answer:
        row.answer_json === null ? null : parseJson(String(row.answer_json)),
      answerSource: row.answer_source === null ? null : String(row.answer_source),
    };
  }

  appendRunEvent(runId: string, type: string, payload: unknown): number {
    return this.#database.transaction(() => {
      const row = this.#database
        .query(
          "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM run_events WHERE run_id = ?",
        )
        .get(runId) as { sequence: number };
      const inserted = this.#database
        .query(
          `INSERT INTO run_events(run_id, sequence, type, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(runId, row.sequence, type, json(payload), now());
      this.#runProgress.note(runId);
      const eventPayload = payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null;
      if (type === "execution" && typeof eventPayload?.agentId === "string") {
        this.#database.query(
          `INSERT OR IGNORE INTO harness_quota_events(event_id, agent_id, payload_json, created_at)
           SELECT id, ?, payload_json, created_at FROM run_events
           WHERE run_id = ? AND type = 'harness'
             AND json_extract(payload_json, '$.type') = 'rate_limit_event'`,
        ).run(eventPayload.agentId, runId);
      }
      if (type === "harness" && eventPayload?.type === "rate_limit_event") {
        const execution = this.#database.query(
          `SELECT json_extract(payload_json, '$.agentId') AS agent_id
           FROM run_events WHERE run_id = ? AND type = 'execution'
           ORDER BY id LIMIT 1`,
        ).get(runId) as { agent_id: unknown } | null;
        if (typeof execution?.agent_id === "string") {
          this.#database.query(
            `INSERT INTO harness_quota_events(event_id, agent_id, payload_json, created_at)
             VALUES (?, ?, ?, ?)`,
          ).run(Number(inserted.lastInsertRowid), execution.agent_id, json(payload), now());
        }
      }
      return row.sequence;
    })();
  }

  listHarnessRunEvents(agentId: string): Array<{ payload: unknown; createdAt: string }> {
    const rows = this.#database.query(
      `SELECT payload_json, created_at FROM harness_quota_events
       WHERE agent_id = ? ORDER BY event_id DESC LIMIT ?`,
    ).all(agentId, 256) as Array<{ payload_json: string; created_at: string }>;
    return rows.map((row) => ({
      payload: parseJson(String(row.payload_json)),
      createdAt: String(row.created_at),
    }));
  }

  listRunEvents(runId: string): Array<{
    sequence: number;
    type: string;
    payload: unknown;
    createdAt: string;
  }> {
    const rows = this.#database
      .query(
        `SELECT sequence, type, payload_json, created_at
         FROM run_events WHERE run_id = ? ORDER BY sequence`,
      )
      .all(runId) as Array<Record<string, SQLQueryBindings>>;
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      type: String(row.type),
      payload: parseJson(String(row.payload_json)),
      createdAt: String(row.created_at),
    }));
  }

  /**
   * Runs that finished before `before` and can no longer be needed to recover work: their item is
   * closed, done or offboarded, or they had no item (steering). Open items' runs are never listed,
   * whatever their state, since a parked or stopped item may resume from them.
   */
  listRetiredRuns(before: string): Array<{ id: string; events: number }> {
    const rows = this.#database
      .query(
        `SELECT r.id, (SELECT COUNT(*) FROM run_events e WHERE e.run_id = r.id) AS events
         FROM runs r LEFT JOIN issues i ON i.id = r.issue_id
         WHERE r.status <> 'running' AND r.finished_at IS NOT NULL AND r.finished_at < ?
           AND (r.issue_id IS NULL OR i.id IS NULL OR i.source_state = 'closed' OR i.projected_state IN ('done', 'offboarded'))
         ORDER BY r.finished_at`,
      )
      .all(before) as Array<Record<string, SQLQueryBindings>>;
    return rows.map((row) => ({ id: String(row.id), events: Number(row.events) }));
  }

  /** Deletes the events (transcripts, tool calls) of the given runs; the runs and their results stay. */
  deleteRunEvents(runIds: readonly string[]): number {
    const remove = this.#database.query("DELETE FROM run_events WHERE run_id = ?");
    return this.#database.transaction(() => runIds.reduce((total, id) => total + remove.run(id).changes, 0))();
  }

  /** An item's run events across all its runs, oldest first, after the event id `afterId`. */
  listIssueRunEventsAfter(issueId: string, afterId: number, limit: number): Array<{
    id: number;
    runId: string;
    stageId: string;
    kind: string;
    type: string;
    payload: unknown;
    createdAt: string;
  }> {
    const rows = this.#database
      .query(
        `SELECT e.id, e.run_id, r.stage_id, r.kind, e.type, e.payload_json, e.created_at
         FROM run_events e JOIN runs r ON r.id = e.run_id
         WHERE r.issue_id = ? AND e.id > ? ORDER BY e.id LIMIT ?`,
      )
      .all(issueId, afterId, limit) as Array<Record<string, SQLQueryBindings>>;
    return rows.map((row) => ({
      id: Number(row.id),
      runId: String(row.run_id),
      stageId: String(row.stage_id),
      kind: String(row.kind),
      type: String(row.type),
      payload: parseJson(String(row.payload_json)),
      createdAt: String(row.created_at),
    }));
  }

  listRunEventsPage(
    runId: string,
    options: { before?: number | undefined; limit: number },
  ): {
    events: Array<{ sequence: number; type: string; payload: unknown; createdAt: string }>;
    nextBefore: number | null;
  } {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new Error("run event page limit must be between 1 and 100");
    }
    const rows = (options.before === undefined
      ? this.#database
        .query(
          `SELECT sequence, type, payload_json, created_at
           FROM run_events WHERE run_id = ? ORDER BY sequence DESC LIMIT ?`,
        )
        .all(runId, options.limit + 1)
      : this.#database
        .query(
          `SELECT sequence, type, payload_json, created_at
           FROM run_events WHERE run_id = ? AND sequence < ?
           ORDER BY sequence DESC LIMIT ?`,
        )
        .all(runId, options.before, options.limit + 1)) as Array<Record<string, SQLQueryBindings>>;
    const hasMore = rows.length > options.limit;
    const events = rows.slice(0, options.limit).map((row) => ({
      sequence: Number(row.sequence),
      type: String(row.type),
      payload: parseJson(String(row.payload_json)),
      createdAt: String(row.created_at),
    }));
    return {
      events,
      nextBefore: hasMore ? (events.at(-1)?.sequence ?? null) : null,
    };
  }

  appendConversationMessage(input: {
    issueId: string;
    runId: string | null;
    stageId: string | null;
    questionId?: string | null;
    actorType: "agent" | "user" | "conveyor";
    actorId: string;
    actorName: string;
    actorTitle: string | null;
    message: string;
  }): StoredConversationMessage {
    let message = input.message.trim();
    if (!message) throw new Error("conversation message must not be empty");
    if (message.length > CONVERSATION_MESSAGE_LIMIT) {
      // A person's message is validated where it is typed. A message Conveyor or an agent produces
      // (e.g. a CI failure with logs) is trimmed: dropping it would fail the stage that reports it.
      if (input.actorType === "user") throw new Error("conversation message must not exceed 4000 characters");
      message = trimToLimit(message);
    }
    const createdAt = now();
    const result = this.#database.transaction(() => {
      const inserted = this.#database
      .query(
        `INSERT INTO conversation_messages(
           issue_id, run_id, stage_id, question_id, actor_type, actor_id, actor_name,
           actor_title, message, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.issueId,
        input.runId,
        input.stageId,
        input.questionId ?? null,
        input.actorType,
        input.actorId,
        input.actorName,
        input.actorTitle,
        message,
        createdAt,
      );
      this.#events.append("message.posted", { messageId: String(inserted.lastInsertRowid), role: input.actorType }, { issueId: input.issueId });
      return inserted;
    })();
    return {
      id: Number(result.lastInsertRowid),
      ...input,
      questionId: input.questionId ?? null,
      message,
      createdAt,
    };
  }

  listConversationMessages(issueId: string, limit = 100): StoredConversationMessage[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("conversation message limit must be between 1 and 200");
    }
    const rows = this.#database
      .query(
        `SELECT * FROM (
           SELECT * FROM conversation_messages
           WHERE issue_id = ? ORDER BY id DESC LIMIT ?
         ) ORDER BY id`,
      )
      .all(issueId, limit) as Array<Record<string, SQLQueryBindings>>;
    return rows.map((row) => ({
      id: Number(row.id),
      issueId: String(row.issue_id),
      runId: row.run_id === null ? null : String(row.run_id),
      stageId: row.stage_id === null ? null : String(row.stage_id),
      questionId: row.question_id === null ? null : String(row.question_id),
      actorType: String(row.actor_type),
      actorId: String(row.actor_id),
      actorName: String(row.actor_name),
      actorTitle: row.actor_title === null ? null : String(row.actor_title),
      message: String(row.message),
      createdAt: String(row.created_at),
    }));
  }
}
