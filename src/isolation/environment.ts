import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
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

/**
 * The only parent variables an agent run may start from. A harness's own variables are not here:
 * each harness names them in its profile's control plane, so no other harness inherits them.
 */
const INHERITED = [
  "HOME", "USER", "LOGNAME", "PATH", "TERM", "COLORTERM", "LANG", "LC_ALL", "TMPDIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
] as const;

/**
 * The absolute path of the bash Conveyor gives every agent as `SHELL`: the first `bash` on `searchPath`
 * (default: the service's own PATH), else a standard location. Undefined when there is none.
 */
export function resolveBash(searchPath: string | undefined = process.env.PATH): string | undefined {
  const found = Bun.which("bash", { PATH: searchPath ?? "" });
  if (found) return path.resolve(found);
  return ["/bin/bash", "/usr/bin/bash"].find((candidate) => existsSync(candidate));
}

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
 * The environment every agent process is spawned with: the inherited allowlist plus the variables
 * the harness's own control plane needs (`controlPlane`) and the caller's overrides, minus
 * credentials, with HOME pointing at the run's sanitized home under `artifactsDirectory`.
 */
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
  const bash = resolveBash(options.overrides?.PATH ?? parent.PATH);
  if (!bash) throw new Error("bash is required to run agents and was not found; install it (for example: sudo apt install bash)");
  const base: Environment = {};
  for (const name of [...INHERITED, ...options.controlPlane]) base[name] = parent[name];
  Object.assign(base, options.overrides);
  const home = await prepareSanitizedHome({
    root: path.dirname(artifactsDirectory),
    runId: path.basename(artifactsDirectory),
    gitUser: await readGitUser(workspace, parent),
  });
  const env = sanitizedAgentEnvironment({ ...base, HOME: parent.HOME }, { home, controlPlane: options.controlPlane });
  // Conveyor declares the shell agents run commands with; the operator's login shell never reaches them.
  env.SHELL = bash;
  return env;
}
