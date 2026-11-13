// pi keeps its login, settings and MCP servers in its agent directory (`PI_CODING_AGENT_DIR`). Each
// run gets a private one inside its own home, holding a copy of the service's login and the
// settings and servers Conveyor chooses; what the run produced is synchronised back when it ends.

import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Environment } from "../../isolation/environment";

/** The variable that points pi at its agent directory. */
export const PI_AGENT_DIRECTORY = "PI_CODING_AGENT_DIR";
/** The login files a run starts from: credentials, and custom providers and models. */
const LOGIN_FILES = ["auth.json", "models.json"] as const;
/** Where a run's private agent directory keeps its sessions (`--session-dir`). */
const PRIVATE_SESSIONS = "sessions";
/** Where the service's agent directory keeps Conveyor's run sessions, apart from the operator's own. */
const SERVICE_SESSIONS = "conveyor-sessions";
/** A session id pi accepts: letters, digits, `.`, `_` and `-`, starting and ending with a letter or digit. */
const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
/** A session file pi writes: `<timestamp>_<session id>.jsonl`. */
const SESSION_FILE = /^[A-Za-z0-9._-]+_[A-Za-z0-9._-]+\.jsonl$/;

/** The service's own pi agent directory: the configured one, the inherited variable, or `~/.pi/agent`. */
export function servicePiAgentDirectory(overrides?: Record<string, string>, parent: Environment = process.env): string {
  const configured = overrides?.[PI_AGENT_DIRECTORY] ?? parent[PI_AGENT_DIRECTORY];
  if (configured) return configured;
  if (!parent.HOME) throw new Error(`cannot locate ~/.pi/agent: neither ${PI_AGENT_DIRECTORY} nor HOME is set`);
  return path.join(parent.HOME, ".pi", "agent");
}

/** The private agent directory of a run whose sanitized home is `home`. */
export function privatePiAgentDirectory(home: string): string {
  return path.join(home, ".pi", "agent");
}

export interface PiAgentDirectory {
  /** The private agent directory, for `PI_CODING_AGENT_DIR`. */
  directory: string;
  /** Its session directory, for `--session-dir`. */
  sessions: string;
  /** The resumed session's file inside it, for `--session`. */
  resumeFile?: string;
}

/**
 * Creates a run's private agent directory inside its home: the service's login copied in, Conveyor's
 * own `settings.json` and `mcp.json` (never the operator's), and the resumed session's record.
 */
export async function preparePiAgentDirectory(options: {
  home: string;
  serviceDirectory: string;
  settings: Record<string, unknown>;
  mcp: Record<string, unknown>;
  resumeSessionId?: string | undefined;
}): Promise<PiAgentDirectory> {
  const directory = privatePiAgentDirectory(options.home);
  const sessions = path.join(directory, PRIVATE_SESSIONS);
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  for (const name of LOGIN_FILES) {
    const content = await readServiceFile(path.join(options.serviceDirectory, name));
    if (content) await writeFile(path.join(directory, name), content, { mode: 0o600 });
  }
  await writeFile(path.join(directory, "settings.json"), `${JSON.stringify(options.settings, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(directory, "mcp.json"), `${JSON.stringify(options.mcp, null, 2)}\n`, { mode: 0o600 });
  if (!options.resumeSessionId) return { directory, sessions };
  if (!SESSION_ID.test(options.resumeSessionId)) throw new Error(`cannot resume pi session ${JSON.stringify(options.resumeSessionId)}: it is not a pi session id`);
  const stored = path.join(options.serviceDirectory, SERVICE_SESSIONS);
  const name = (await readdir(stored).catch(() => [] as string[])).filter((file) => file.endsWith(`_${options.resumeSessionId}.jsonl`)).sort().at(-1);
  const content = name ? await readServiceFile(path.join(stored, name)) : undefined;
  if (!name || !content) throw new Error(`cannot resume pi session ${options.resumeSessionId}: its record is not in ${stored}`);
  const resumeFile = path.join(sessions, name);
  await writeFile(resumeFile, content, { mode: 0o600 });
  return { directory, sessions, resumeFile };
}

/**
 * Returns what a run produced in its private agent directory to the service's: its session records
 * (so a later run can resume them) and a refreshed login. Nothing else comes back.
 */
export async function syncPiAgentDirectory(options: { home: string; serviceDirectory: string }): Promise<void> {
  // The private directory is writable by the agent, so nothing in it is trusted: each directory on
  // the way must be a real directory (never a symlink to elsewhere), only regular files are read
  // (never through a final symlink), and only a well-formed login is promoted.
  const directory = privatePiAgentDirectory(options.home);
  for (const step of [options.home, path.join(options.home, ".pi"), directory]) if (!(await isRealDirectory(step))) return;
  const sessions = path.join(directory, PRIVATE_SESSIONS);
  if (await isRealDirectory(sessions)) {
    for (const entry of await readdir(sessions, { withFileTypes: true })) {
      if (!entry.isFile() || !SESSION_FILE.test(entry.name)) continue;
      const content = await readRegularFile(path.join(sessions, entry.name));
      if (!content) continue;
      const target = path.join(options.serviceDirectory, SERVICE_SESSIONS, entry.name);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { mode: 0o600 });
    }
  }
  const updated = await readRegularFile(path.join(directory, "auth.json"));
  if (!updated || !isJsonObject(updated)) return;
  const service = path.join(options.serviceDirectory, "auth.json");
  const current = await readRegularFile(service);
  if (!current || !updated.equals(current)) {
    await mkdir(options.serviceDirectory, { recursive: true, mode: 0o700 });
    await writeFile(service, updated, { mode: 0o600 });
  }
}

async function isRealDirectory(directory: string): Promise<boolean> {
  try {
    return (await lstat(directory)).isDirectory();
  } catch {
    return false;
  }
}

/** Reads a file of the service's own agent directory, which is trusted; a missing one yields undefined. */
async function readServiceFile(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Reads a regular file without following a final symlink; anything else yields undefined. */
async function readRegularFile(file: string): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) return undefined;
    return await handle.readFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

function isJsonObject(content: Buffer): boolean {
  try {
    const value = JSON.parse(content.toString("utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}
