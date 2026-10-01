import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

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
const SECRET_NAME = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)($|_)/i;

/** Variables the Codex harness needs for its own (outside-the-sandbox) control plane. */
export const CODEX_CONTROL_PLANE: readonly string[] = ["CODEX_HOME"];

/** The only parent variables an agent run may start from. */
const INHERITED = [
  "HOME", "USER", "LOGNAME", "PATH", "SHELL", "TERM", "COLORTERM", "LANG", "LC_ALL", "TMPDIR",
  "CODEX_HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
] as const;

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
    } else if (!DROPPED.has(name) && !name.startsWith("CONVEYOR_") && !SECRET_NAME.test(name)) {
      env[name] = value;
    }
  }
  if (control.has("CODEX_HOME") && env.CODEX_HOME === undefined && base.HOME) {
    env.CODEX_HOME = path.join(base.HOME, ".codex");
  }
  env.HOME = options.home;
  return env;
}

function gitconfigValue(value: string): string {
  return JSON.stringify(value.replace(/[\r\n]+/g, " "));
}

/** Creates `<root>/<runId>/home` holding only a minimal `.gitconfig` and returns its path. */
export async function prepareSanitizedHome(options: { root: string; runId: string; gitUser: GitUser }): Promise<string> {
  const home = path.join(options.root, options.runId, "home");
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  const lines: string[] = [];
  if (options.gitUser.name) lines.push(`\tname = ${gitconfigValue(options.gitUser.name)}`);
  if (options.gitUser.email) lines.push(`\temail = ${gitconfigValue(options.gitUser.email)}`);
  await writeFile(path.join(home, ".gitconfig"), lines.length ? `[user]\n${lines.join("\n")}\n` : "");
  return home;
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
  const [name, email] = await Promise.all([gitValue(workspace, "user.name", env), gitValue(workspace, "user.email", env)]);
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
}): Promise<Record<string, string>> {
  const parent = options.parent ?? process.env;
  const base: Environment = {};
  for (const name of INHERITED) base[name] = parent[name];
  Object.assign(base, options.overrides);
  const home = await prepareSanitizedHome({
    root: path.dirname(options.artifactsDirectory),
    runId: path.basename(options.artifactsDirectory),
    gitUser: await readGitUser(options.workspace, parent),
  });
  return sanitizedAgentEnvironment({ ...base, HOME: parent.HOME }, { home, controlPlane: CODEX_CONTROL_PLANE });
}
