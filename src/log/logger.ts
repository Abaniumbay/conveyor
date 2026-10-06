// Service logs: startup and shutdown, configuration failures, scheduling, provider and
// infrastructure errors. Each record carries a timestamp, a level and, where it applies, the
// repository, item, stage and run it concerns. Records go to stdout/stderr (the journal under
// systemd) and, once the service starts, to <logs>/conveyor.log as JSON lines with size-based
// rotation. Agent transcripts are not logged here: they stay in the run history.

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export const LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LEVELS)[number];

/** Correlation fields; any other field is free-form context. */
export interface LogFields {
  repository?: string | undefined;
  /** The item as <repository>:<number>. */
  item?: string | undefined;
  stage?: string | undefined;
  run?: string | undefined;
  [key: string]: unknown;
}

export interface LogRecord extends LogFields {
  time: string;
  level: LogLevel;
  message: string;
}

export interface LogSink {
  write(record: LogRecord): void;
}

export const LOG_FILE = "conveyor.log";

/** Patterns of credentials that must never reach a log, even when a value is not a known secret. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g,
  /\b(github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(sk-(?:ant-)?[A-Za-z0-9_-]{20,})\b/g,
  /\b(xox[abprs]-[A-Za-z0-9-]{10,})\b/g,
];
const AUTHORIZATION = /\b(authorization|proxy-authorization)(["']?\s*[:=]\s*["']?)(bearer\s+|basic\s+|token\s+)?[^\s"',;]+/gi;
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** Environment variables whose values are credentials. */
export const SECRET_ENVIRONMENT = [
  "CONVEYOR_GITHUB_WEBHOOK_SECRET", "CONVEYOR_SESSION_SECRET", "CONVEYOR_PASSWORD_HASH", "CONVEYOR_VAPID_PRIVATE_KEY",
  "GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

export class Redactor {
  #secrets: string[] = [];

  constructor(secrets: readonly string[] = [], environment: NodeJS.ProcessEnv = process.env) {
    this.add([...secrets, ...SECRET_ENVIRONMENT.map((name) => environment[name] ?? "")]);
  }

  /** Adds known secret values (shorter than 6 characters are ignored: too likely to hit ordinary text). */
  add(secrets: readonly string[]): void {
    this.#secrets = [...new Set([...this.#secrets, ...secrets.filter((secret) => secret.length >= 6)])].sort((left, right) => right.length - left.length);
  }

  text(value: string): string {
    let text = value;
    for (const secret of this.#secrets) text = text.split(secret).join("<redacted>");
    for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, "<redacted>");
    return text.replace(AUTHORIZATION, (_match, name: string, separator: string, scheme: string | undefined) => `${name}${separator}${scheme ?? ""}<redacted>`)
      .replace(BEARER, "$1 <redacted>");
  }

  value<T>(value: T): T {
    const visit = (item: unknown): unknown => {
      if (typeof item === "string") return this.text(item);
      if (Array.isArray(item)) return item.map(visit);
      if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)]));
      return item;
    };
    return visit(value) as T;
  }
}

function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) return { error: error.message };
  return error === undefined ? {} : { error: String(error) };
}

/** One human-readable line: time, level, message, then key=value context. */
export function formatRecord(record: LogRecord): string {
  const { time, level, message, ...fields } = record;
  const context = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === "string" && !/\s/.test(value) ? value : JSON.stringify(value)}`);
  return [time, level.toUpperCase().padEnd(5), message, ...context].join(" ");
}

export class ConsoleSink implements LogSink {
  constructor(readonly format: "text" | "json" = "text") {}

  write(record: LogRecord): void {
    const line = this.format === "json" ? JSON.stringify(record) : formatRecord(record);
    if (record.level === "error" || record.level === "warn") process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }
}

/** JSON lines in <directory>/conveyor.log; past `maxBytes` it becomes conveyor.log.1 and older files shift up to `keepFiles`. */
export class FileSink implements LogSink {
  readonly file: string;
  #size: number;

  constructor(readonly directory: string, readonly maxBytes: number, readonly keepFiles: number) {
    mkdirSync(directory, { recursive: true, mode: 0o750 });
    this.file = path.join(directory, LOG_FILE);
    this.#size = statSync(this.file, { throwIfNoEntry: false })?.size ?? 0;
  }

  write(record: LogRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (this.#size > 0 && this.#size + bytes > this.maxBytes) this.rotate();
    appendFileSync(this.file, line, { mode: 0o640 });
    this.#size += bytes;
  }

  rotate(): void {
    rmSync(`${this.file}.${this.keepFiles}`, { force: true });
    for (let index = this.keepFiles - 1; index >= 1; index -= 1) {
      try {
        renameSync(`${this.file}.${index}`, `${this.file}.${index + 1}`);
      } catch {
        // That generation does not exist yet.
      }
    }
    if (this.keepFiles > 0) renameSync(this.file, `${this.file}.1`);
    else rmSync(this.file, { force: true });
    this.#size = 0;
  }
}

export class Logger {
  #sinks: LogSink[] = [new ConsoleSink()];
  #level: LogLevel = "info";
  #redactor = new Redactor();

  configure(options: { sinks?: LogSink[]; level?: LogLevel; redactor?: Redactor }): void {
    if (options.sinks) this.#sinks = options.sinks;
    if (options.level) this.#level = options.level;
    if (options.redactor) this.#redactor = options.redactor;
  }

  log(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (LEVELS.indexOf(level) < LEVELS.indexOf(this.#level)) return;
    const record = this.#redactor.value({ time: new Date().toISOString(), level, message, ...fields }) as LogRecord;
    for (const sink of this.#sinks) {
      try {
        sink.write(record);
      } catch (error) {
        // A failing sink (a full disk) must not take the service down; the console still has it.
        process.stderr.write(`log sink failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }

  debug(message: string, fields?: LogFields): void { this.log("debug", message, fields); }
  info(message: string, fields?: LogFields): void { this.log("info", message, fields); }
  warn(message: string, fields?: LogFields, error?: unknown): void { this.log("warn", message, { ...fields, ...errorFields(error) }); }
  error(message: string, fields?: LogFields, error?: unknown): void { this.log("error", message, { ...fields, ...errorFields(error) }); }
}

/** The process-wide service logger; `serve` configures its sinks. */
export const log = new Logger();
