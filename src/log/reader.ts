// Reads the service log files (conveyor.log and its rotations) for `conveyor logs`, without the
// service: filtering by level, time, item and stage, and following across rotation.

import { open, readdir, readFile, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { LEVELS, LOG_FILE, type LogLevel, type LogRecord } from "./logger";

export interface LogQuery {
  /** The minimum level. */
  level?: LogLevel;
  /** Only records at or after this time (ms since the epoch). */
  since?: number;
  item?: string;
  stage?: string;
}

export function parseLogLine(line: string): LogRecord | null {
  try {
    const record = JSON.parse(line) as LogRecord;
    return typeof record.time === "string" && LEVELS.includes(record.level) && typeof record.message === "string" ? record : null;
  } catch {
    return null;
  }
}

export function matchesQuery(record: LogRecord, query: LogQuery): boolean {
  if (query.level && LEVELS.indexOf(record.level) < LEVELS.indexOf(query.level)) return false;
  if (query.since !== undefined && Date.parse(record.time) < query.since) return false;
  if (query.item && record.item !== query.item) return false;
  if (query.stage && record.stage !== query.stage) return false;
  return true;
}

/** The log files, oldest first: conveyor.log.N ... conveyor.log.1, conveyor.log. */
export async function logFiles(directory: string): Promise<string[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const rotated = names
    .map((name) => ({ name, generation: name === LOG_FILE ? 0 : Number(/^conveyor\.log\.(\d+)$/.exec(name)?.[1] ?? NaN) }))
    .filter((entry) => Number.isInteger(entry.generation))
    .sort((left, right) => right.generation - left.generation);
  return rotated.map((entry) => path.join(directory, entry.name));
}

/** An open conveyor.log and the offset up to which it has been read: where following continues. */
export interface LogCursor {
  handle: FileHandle | null;
  position: number;
}

/** Opens conveyor.log at its current end. Read history with it, then follow from it: nothing in between is lost or repeated. */
export async function openLogCursor(directory: string): Promise<LogCursor> {
  const handle = await open(path.join(directory, LOG_FILE), "r").catch(() => null);
  return { handle, position: handle ? (await handle.stat()).size : 0 };
}

async function readRange(handle: FileHandle, end: number): Promise<string> {
  const buffer = Buffer.alloc(end);
  await handle.read(buffer, 0, end, 0);
  return buffer.toString("utf8");
}

/**
 * The records in the log files, oldest first. With a cursor, its file is read only up to the
 * cursor (wherever rotation moved it), and a conveyor.log created after it is left to the follower.
 */
export async function readLogRecords(directory: string, query: LogQuery = {}, cursor?: LogCursor): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  const cursorInode = cursor?.handle ? (await cursor.handle.stat()).ino : null;
  for (const file of await logFiles(directory)) {
    let text: string;
    if (cursor && cursorInode !== null) {
      const inode = (await stat(file).catch(() => null))?.ino;
      if (inode === cursorInode) text = await readRange(cursor.handle!, cursor.position);
      else if (path.basename(file) === LOG_FILE) continue;
      else text = await readFile(file, "utf8").catch(() => "");
    } else {
      text = await readFile(file, "utf8").catch(() => "");
    }
    for (const line of text.split("\n")) {
      const record = line ? parseLogLine(line) : null;
      if (record && matchesQuery(record, query)) records.push(record);
    }
  }
  return records;
}

/**
 * Calls `onRecord` for each record appended to conveyor.log from its current end, following it
 * across rotation until `signal` aborts. The open file is read to its end before switching to a
 * new conveyor.log, so records written just before a rotation are not lost.
 */
export async function followLog(directory: string, query: LogQuery, onRecord: (record: LogRecord) => void, signal: AbortSignal, pollMs = 500, cursor?: LogCursor): Promise<void> {
  const file = path.join(directory, LOG_FILE);
  const start = cursor ?? (await openLogCursor(directory));
  let handle: FileHandle | null = start.handle;
  let position = start.position;
  let partial = "";
  const emit = (text: string) => {
    const lines = (partial + text).split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      const record = parseLogLine(line);
      if (record && matchesQuery(record, query)) onRecord(record);
    }
  };
  /** Reads what the open file gained since the last read (after a rename it is the rotated file). */
  const drain = async () => {
    if (!handle) return;
    const size = (await handle.stat()).size;
    if (size < position) {
      position = 0;
      partial = "";
    }
    if (size === position) return;
    const buffer = Buffer.alloc(size - position);
    await handle.read(buffer, 0, buffer.length, position);
    position = size;
    emit(buffer.toString("utf8"));
  };
  try {
    while (!signal.aborted) {
      await Bun.sleep(pollMs);
      await drain();
      const current = await stat(file).catch(() => null);
      if (!current) continue;
      if (!handle || current.ino !== (await handle.stat()).ino) {
        // Rotated. Read the old file to its end once more: a writer may have appended to it after
        // the read above and before the rotation. Then continue with the new file from its start.
        await drain();
        await handle?.close();
        handle = await open(file, "r").catch(() => null);
        position = 0;
        partial = "";
        await drain();
      }
    }
  } finally {
    await handle?.close();
  }
}
