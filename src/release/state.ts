// Upgrade and rollback bookkeeping in the Conveyor home: the pending switch, the history of
// switches (with the schema version before and after, for rollback), and state backups.
//   <home>/state/releases.json      { pending, history }
//   <home>/backups/<time>-<from>-to-<to>/conveyor.sqlite (+ session-secret)

import { Database } from "bun:sqlite";
import { chown, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { SESSION_SECRET_FILE } from "../web/session-secret";

export interface PendingSwitch {
  id: string;
  kind: "upgrade" | "rollback";
  /** The version to switch to; installed in `prefix`. */
  version: string;
  from: string;
  prefix: string;
  /** For a rollback: the backup to restore before switching. */
  restoreBackup: string | null;
  requestedAt: string;
  /** If the service is not idle by then, the switch is cancelled and admission resumes. */
  drainDeadline: string;
}

export interface SwitchRecord {
  id: string;
  kind: "upgrade" | "rollback";
  from: string;
  to: string;
  /** Database schema before the switch; a rollback to `from` needs the backup when it grew. */
  fromSchema: number | null;
  /** Database schema once `to` started. */
  toSchema: number | null;
  backup: string | null;
  status: "switched" | "completed" | "failed" | "cancelled";
  reason: string | null;
  requestedAt: string;
  finishedAt: string | null;
}

export interface ReleaseState {
  pending: PendingSwitch | null;
  history: SwitchRecord[];
}

export const BACKUPS_KEPT = 5;

/**
 * Run as root (sudo conveyor rollback, upgrade), files written into the home would belong to root
 * and the service account could no longer use them: give `target` the owner of `reference`.
 */
export async function ownLike(target: string, reference: string): Promise<void> {
  if (process.getuid?.() !== 0) return;
  const owner = await stat(reference).catch(() => null);
  if (owner) await chown(target, owner.uid, owner.gid);
}

export function releaseStateFile(home: string): string {
  return path.join(home, "state", "releases.json");
}

export async function readReleaseState(home: string): Promise<ReleaseState> {
  const text = await readFile(releaseStateFile(home), "utf8").catch(() => null);
  if (!text) return { pending: null, history: [] };
  const parsed = JSON.parse(text) as Partial<ReleaseState>;
  return { pending: parsed.pending ?? null, history: parsed.history ?? [] };
}

export async function writeReleaseState(home: string, state: ReleaseState): Promise<void> {
  const file = releaseStateFile(home);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await ownLike(temporary, home);
  await rename(temporary, file);
}

export async function updateRecord(home: string, id: string, update: Partial<SwitchRecord>): Promise<void> {
  const state = await readReleaseState(home);
  state.history = state.history.map((record) => (record.id === id ? { ...record, ...update } : record));
  await writeReleaseState(home, state);
}

/** The latest upgrade that brought `version` in, if any. A rollback is never something to roll back from. */
export function latestUpgradeTo(state: ReleaseState, version: string): SwitchRecord | null {
  return [...state.history].reverse().find((record) =>
    record.kind === "upgrade" && record.to === version && (record.status === "completed" || record.status === "switched")) ?? null;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Writes a consistent copy of the database (VACUUM INTO, safe while the service has it open) and
 * the session secret into a new backup directory, keeping the newest BACKUPS_KEPT backups.
 */
export async function backupState(options: { home: string; database: string; label: string; open?: Database }): Promise<string> {
  const backups = path.join(options.home, "backups");
  const directory = path.join(backups, `${new Date().toISOString().replace(/[:.]/g, "-")}-${options.label}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, "conveyor.sqlite");
  const database = options.open ?? new Database(options.database, { readonly: true });
  try {
    database.exec(`VACUUM INTO ${sqlString(target)}`);
  } finally {
    if (!options.open) database.close();
  }
  const secret = path.join(path.dirname(options.database), SESSION_SECRET_FILE);
  if (await stat(secret).catch(() => null)) await copyFile(secret, path.join(directory, SESSION_SECRET_FILE));
  for (const file of [backups, directory, ...(await readdir(directory)).map((name) => path.join(directory, name))]) await ownLike(file, options.home);
  const entries = (await readdir(backups, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const old of entries.slice(0, Math.max(0, entries.length - BACKUPS_KEPT))) await rm(path.join(backups, old), { recursive: true, force: true });
  return directory;
}

/** Replaces the database (and session secret) with a backup. The database must not be open. */
export async function restoreState(backup: string, database: string): Promise<void> {
  const source = path.join(backup, "conveyor.sqlite");
  if (!(await stat(source).catch(() => null))?.isFile()) throw new Error(`${backup} holds no database backup`);
  const temporary = `${database}.restore`;
  // The restored files keep the owner of what they replace (or of the database directory).
  const reference = (await stat(database).catch(() => null)) ? database : path.dirname(database);
  await copyFile(source, temporary);
  await ownLike(temporary, reference);
  await rm(`${database}-wal`, { force: true });
  await rm(`${database}-shm`, { force: true });
  await rename(temporary, database);
  const secret = path.join(backup, SESSION_SECRET_FILE);
  if (await stat(secret).catch(() => null)) {
    const destination = path.join(path.dirname(database), SESSION_SECRET_FILE);
    await copyFile(secret, destination);
    await ownLike(destination, reference);
  }
}

export class RollbackRefused extends Error {
  override readonly name = "RollbackRefused";
}

/**
 * What a rollback from `running` does: back to the version the last upgrade replaced, restoring
 * that upgrade's backup when asked. When the newer release migrated the database (its schema grew
 * since the upgrade), the backup is required: the older release cannot run on the newer schema.
 */
export function planRollback(
  state: ReleaseState,
  running: string,
  schemaNow: number,
  restoreBackup: boolean,
): { target: string; restoreBackup: string | null; record: SwitchRecord } {
  const record = latestUpgradeTo(state, running);
  if (!record) {
    throw new RollbackRefused(`no upgrade to ${running} is recorded in this home, so there is no known previous version to roll back to; install one with conveyor upgrade --version <version>`);
  }
  const migrated = record.fromSchema === null || schemaNow > record.fromSchema;
  if (migrated && !restoreBackup) {
    throw new RollbackRefused(
      `${running} migrated the database (schema ${record.fromSchema ?? "unknown"} -> ${schemaNow}), which ${record.from} cannot use. ` +
      `Roll back with --restore-backup to restore the state saved before the upgrade (${record.requestedAt}); work recorded since then is lost.`,
    );
  }
  if (restoreBackup && !record.backup) throw new RollbackRefused(`the upgrade to ${running} kept no backup to restore`);
  return { target: record.from, restoreBackup: restoreBackup ? record.backup : null, record };
}
