import { constants } from "node:fs";
import { chmod, copyFile, mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveFilesystemPath, resolvePathEnvironment } from "../core/paths";

export type Environment = Record<string, string | undefined>;

export interface GitUser {
  name?: string;
  email?: string;
}

/** Source-provider credentials and credential helpers an agent must never inherit. */
const DROPPED = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GIT_ASKPASS",
  "SSH_AUTH_SOCK",
  "GH_CONFIG_DIR",
  "GIT_CONFIG_GLOBAL",
]);
const DROPPED_PATTERNS = [
  /^GIT_(CONFIG|SSH|CREDENTIAL|ASKPASS)/,
  /^GH_/,
  /^XDG_(CONFIG|DATA)_HOME$/,
  /CREDENTIALS?$/i,
  /^AWS_ACCESS_KEY_ID$/,
];
const SECRET_NAME = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)($|_)/i;

/** Variables the Codex harness needs for its own (outside-the-sandbox) control plane. */
export const CODEX_CONTROL_PLANE: readonly string[] = ["CODEX_HOME"];

/** The only parent variables an agent run may start from. */
const INHERITED = [
  "HOME", "USER", "LOGNAME", "PATH", "SHELL", "TERM", "COLORTERM", "LANG", "LC_ALL", "TMPDIR",
  "CODEX_HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
] as const;

function stripUserinfo(value: string): string {
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}

export function sanitizedAgentEnvironment(
  base: Environment,
  options: { home: string; controlPlane: readonly string[] },
): Record<string, string> {
  const control = new Set(options.controlPlane);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || name === "HOME") continue;
    if (control.has(name)) {
      env[name] = value;
    } else if (
      !DROPPED.has(name) &&
      !name.startsWith("CONVEYOR_") &&
      !SECRET_NAME.test(name) &&
      !DROPPED_PATTERNS.some((pattern) => pattern.test(name))
    ) {
      env[name] = /^(https?|no|all)_proxy$/i.test(name) ? stripUserinfo(value) : value;
    }
  }
  if (control.has("CODEX_HOME") && env.CODEX_HOME === undefined) {
    if (!base.HOME) throw new Error("cannot locate ~/.codex: neither CODEX_HOME nor HOME is set");
    env.CODEX_HOME = path.join(base.HOME, ".codex");
  }
  env.HOME = options.home;
  return resolvePathEnvironment(env);
}

function gitconfigValue(value: string): string {
  return JSON.stringify(value.replace(/[\u0000-\u001f\u007f]+/g, " "));
}

/** Creates `<root>/<runId>/home` holding only a minimal `.gitconfig` and returns its path. */
export async function prepareSanitizedHome(options: { root: string; runId: string; gitUser: GitUser }): Promise<string> {
  const home = path.join(options.root, options.runId, "home");
  await mkdir(home, { recursive: true });
  for (const entry of await readdir(home)) {
    if (entry !== ".gitconfig") await rm(path.join(home, entry), { recursive: true, force: true });
  }
  const lines: string[] = [];
  if (options.gitUser.name) lines.push(`\tname = ${gitconfigValue(options.gitUser.name)}`);
  if (options.gitUser.email) lines.push(`\temail = ${gitconfigValue(options.gitUser.email)}`);
  await writeFile(path.join(home, ".gitconfig"), lines.length ? `[user]\n${lines.join("\n")}\n` : "");
  return resolveFilesystemPath(home);
}

/** Removes only the private home belonging to one completed run. Symbolic links are unlinked, not followed. */
export async function cleanupSanitizedHome(artifactsDirectory: string): Promise<void> {
  const home = path.join(path.resolve(artifactsDirectory), "home");
  await rm(home, { recursive: true, force: true });
}

async function gitValue(cwd: string, key: string, env: Environment): Promise<string | undefined> {
  try {
    const clean = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const child = Bun.spawn(["git", "config", "--get", key], { cwd, env: clean, stdout: "pipe", stderr: "ignore" });
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const value = text.trim();
    return code === 0 && value ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Reads only user.name and user.email (local config first, then global); nothing else is copied. */
export async function readGitUser(workspace: string, env: Environment = process.env): Promise<GitUser> {
  const cwd = resolveFilesystemPath(workspace);
  const [name, email] = await Promise.all([gitValue(cwd, "user.name", env), gitValue(cwd, "user.email", env)]);
  return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
}

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
  const env = await prepareAgentEnvironment({ ...rest, controlPlane: CODEX_CONTROL_PLANE });
  // The service's Codex home holds every run's credentials and sessions. The harness gets a
  // private one inside this run's home instead; commands never receive its location (the shell
  // policy excludes CODEX_HOME) and it is deleted with the home when the run ends.
  const serviceHome = env.CODEX_HOME!;
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

/** The same for any harness, keeping the variables its own control plane needs (`controlPlane`). */
export async function prepareAgentEnvironment(options: {
  artifactsDirectory: string;
  workspace: string;
  overrides?: Record<string, string> | undefined;
  parent?: Environment;
  controlPlane: readonly string[];
}): Promise<Record<string, string>> {
  const artifactsDirectory = resolveFilesystemPath(options.artifactsDirectory);
  const workspace = resolveFilesystemPath(options.workspace);
  const parent = options.parent ?? process.env;
  const base: Environment = {};
  for (const name of [...INHERITED, ...options.controlPlane]) base[name] = parent[name];
  Object.assign(base, options.overrides);
  const home = await prepareSanitizedHome({
    root: path.dirname(artifactsDirectory),
    runId: path.basename(artifactsDirectory),
    gitUser: await readGitUser(workspace, parent),
  });
  return sanitizedAgentEnvironment({ ...base, HOME: parent.HOME }, { home, controlPlane: options.controlPlane });
}

/** The service's own Codex home: an explicit override, the inherited variable, or `~/.codex`. */
export function serviceCodexHome(overrides?: Record<string, string>, parent: Environment = process.env): string {
  const configured = overrides?.CODEX_HOME ?? parent.CODEX_HOME;
  if (configured) return configured;
  if (!parent.HOME) throw new Error("cannot locate ~/.codex: neither CODEX_HOME nor HOME is set");
  return path.join(parent.HOME, ".codex");
}
