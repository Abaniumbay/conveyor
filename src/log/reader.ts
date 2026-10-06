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

export async function readLogRecords(directory: string, query: LogQuery = {}): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  for (const file of await logFiles(directory)) {
    const text = await readFile(file, "utf8").catch(() => "");
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
export async function followLog(directory: string, query: LogQuery, onRecord: (record: LogRecord) => void, signal: AbortSignal, pollMs = 500): Promise<void> {
  const file = path.join(directory, LOG_FILE);
  let handle: FileHandle | null = await open(file, "r").catch(() => null);
  let position = handle ? (await handle.stat()).size : 0;
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
        // Rotated: the old file was read to its end above; continue with the new one from its start.
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
