import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveFilesystemPath, resolvePathEnvironment } from "../core/paths";
import { defaultRunVariables } from "./run-environment";

export type Environment = Record<string, string | undefined>;

export interface GitUser {
  name?: string;
  email?: string;
}

/**
 * The absolute path of the bash Conveyor gives every agent as `SHELL`: the first `bash` on `searchPath`
 * (default: the service's own PATH), else a standard location. Undefined when there is none.
 */
export function resolveBash(searchPath: string | undefined = process.env.PATH): string | undefined {
  const found = Bun.which("bash", { PATH: searchPath ?? "" });
  if (found) return path.resolve(found);
  return ["/bin/bash", "/usr/bin/bash"].find((candidate) => existsSync(candidate));
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
 * The environment an agent process is spawned with: exactly the run's `variables` (absent: the root
 * default's from the service), with `HOME` pointing at the run's private home under
 * `artifactsDirectory` and `SHELL` at Conveyor's bash. Nothing is inherited or filtered by name: the
 * configuration decides what a run sees.
 */
export async function prepareAgentEnvironment(options: {
  artifactsDirectory: string;
  workspace: string;
  variables?: Record<string, string> | undefined;
  parent?: Environment;
}): Promise<Record<string, string>> {
  const artifactsDirectory = resolveFilesystemPath(options.artifactsDirectory);
  const workspace = resolveFilesystemPath(options.workspace);
  const parent = options.parent ?? process.env;
  const variables = options.variables ?? defaultRunVariables(parent);
  const bash = resolveBash(variables.PATH ?? parent.PATH);
  if (!bash) throw new Error("bash is required to run agents and was not found; install it (for example: sudo apt install bash)");
  const home = await prepareSanitizedHome({
    root: path.dirname(artifactsDirectory),
    runId: path.basename(artifactsDirectory),
    gitUser: await readGitUser(workspace, parent),
  });
  // Conveyor declares the shell agents run commands with; the operator's login shell never reaches them.
  return resolvePathEnvironment({ ...variables, HOME: home, SHELL: bash });
}
