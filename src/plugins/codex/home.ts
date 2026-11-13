// Codex keeps its login and sessions in its home (`CODEX_HOME`). Each run gets a private copy of
// what it needs, and what the run produced is synchronised back when it ends.

import { constants } from "node:fs";
import { chmod, copyFile, mkdir, open, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { prepareAgentEnvironment, type Environment } from "../../isolation/environment";

/** Variables the Codex harness needs for its own (outside-the-sandbox) control plane. */
export const CODEX_CONTROL_PLANE: readonly string[] = ["CODEX_HOME"];

/**
 * The environment every Codex agent process is spawned with: the inherited allowlist (plus the
 * caller's overrides) minus credentials, with HOME pointing at the run's sanitized home under
 * `artifactsDirectory`.
 */
export async function prepareCodexEnvironment(options: {
  artifactsDirectory: string;
  workspace: string;
  overrides?: Record<string, string> | undefined;
  parent?: Environment;
  /** A persisted session the run resumes; its record is copied into the private Codex home. */
  resumeSessionId?: string | undefined;
}): Promise<Record<string, string>> {
  const { resumeSessionId, ...rest } = options;
  const serviceHome = serviceCodexHome(options.overrides, options.parent ?? process.env);
  const env = await prepareAgentEnvironment({
    ...rest,
    overrides: { ...options.overrides, CODEX_HOME: serviceHome },
    controlPlane: CODEX_CONTROL_PLANE,
  });
  // The service's Codex home holds every run's credentials and sessions. The harness gets a
  // private one inside this run's home instead; commands never receive its location (the shell
  // policy excludes CODEX_HOME) and it is deleted with the home when the run ends.
  const privateHome = path.join(env.HOME!, ".codex");
  await mkdir(privateHome, { recursive: true, mode: 0o700 });
  await copyIfPresent(path.join(serviceHome, "auth.json"), path.join(privateHome, "auth.json"));
  if (resumeSessionId) {
    for (const relative of await sessionRecords(serviceHome, resumeSessionId)) {
      await copyIfPresent(path.join(serviceHome, relative), path.join(privateHome, relative));
    }
  }
  return { ...env, CODEX_HOME: privateHome };
}

/**
 * Returns what a run produced in its private Codex home to the service's: persisted session
 * records (so later runs can resume them) and a refreshed authentication record.
 */
export async function syncCodexHome(options: { privateHome: string; serviceHome: string }): Promise<void> {
  // The private home is writable by the agent, so nothing in it is trusted: only regular files are
  // read (never followed through a symlink) and only a well-formed authentication record is promoted.
  const sessions = path.join(options.privateHome, "sessions");
  for (const relative of await listFiles(sessions)) {
    const content = await readRegularFile(path.join(sessions, relative));
    if (!content) continue;
    const target = path.join(options.serviceHome, "sessions", relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { mode: 0o600 });
  }
  const updated = await readRegularFile(path.join(options.privateHome, "auth.json"));
  if (!updated || !isAuthenticationRecord(updated)) return;
  const service = path.join(options.serviceHome, "auth.json");
  const current = await readRegularFile(service);
  if (!current || !updated.equals(current)) {
    await mkdir(options.serviceHome, { recursive: true, mode: 0o700 });
    await writeFile(service, updated, { mode: 0o600 });
  }
}

/** The service's own Codex home: an explicit override, the inherited variable, or `~/.codex`. */
export function serviceCodexHome(overrides?: Record<string, string>, parent: Environment = process.env): string {
  const configured = overrides?.CODEX_HOME ?? parent.CODEX_HOME;
  if (configured) return configured;
  if (!parent.HOME) throw new Error("cannot locate ~/.codex: neither CODEX_HOME nor HOME is set");
  return path.join(parent.HOME, ".codex");
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

function isAuthenticationRecord(content: Buffer): boolean {
  try {
    const value = JSON.parse(content.toString("utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

async function copyIfPresent(source: string, target: string): Promise<void> {
  try {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target);
    await chmod(target, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

async function sessionRecords(codexHome: string, sessionId: string): Promise<string[]> {
  const sessions = path.join(codexHome, "sessions");
  return (await listFiles(sessions))
    .filter((file) => path.basename(file).includes(sessionId))
    .map((file) => path.join("sessions", file));
}
