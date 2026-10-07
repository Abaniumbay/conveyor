import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

// The git operations workspace tasks need, behind an interface so tests use a fake.

export interface GitOps {
  /** Whether the working tree has no uncommitted or untracked changes. */
  status(path: string): Promise<{ clean: boolean }>;
  /** The commit a ref resolves to, or null when it does not exist. */
  revParse(path: string, ref: string): Promise<string | null>;
  /** HEAD against the local remote-tracking ref `origin/<branch>`; null when that ref does not exist. */
  aheadBehind(path: string, branch: string): Promise<{ ahead: number; behind: number } | null>;
  fetch(path: string, remote: string, branch: string): Promise<void>;
  push(path: string, branch: string, options: { forceWithLease: boolean }): Promise<void>;
}

async function run(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function mustRun(cwd: string, args: string[]): Promise<string> {
  const result = await run(cwd, args);
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr || `exit ${result.exitCode}`}`);
  return result.stdout;
}

/**
 * The git metadata a worktree's own commands write: its private git dir (index, HEAD, rebase state)
 * and the shared objects, refs and reflogs. A linked worktree keeps all of these under the main
 * repository's .git, outside the worktree, so a sandbox scoped to the worktree leaves them read-only.
 * Only existing paths are returned; none when the directory is not a git checkout.
 */
export async function worktreeGitPaths(workspace: string): Promise<string[]> {
  const result = await run(workspace, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
  if (result.exitCode !== 0) return [];
  const [gitDir, commonDir] = result.stdout.split("\n");
  if (!gitDir || !commonDir) return [];
  return [gitDir, ...["objects", "refs", "logs"].map((name) => path.join(commonDir, name))];
}

/**
 * Adds patterns to the repository's local exclude file (`info/exclude` in the common git dir, shared by
 * every worktree), so files tools write inside a worktree are never committed. Existing lines are kept;
 * nothing happens outside a git checkout.
 */
export async function ensureGitExcludes(workspace: string, patterns: readonly string[]): Promise<void> {
  if (patterns.length === 0) return;
  const result = await run(workspace, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (result.exitCode !== 0 || !result.stdout) return;
  const file = path.join(result.stdout, "info", "exclude");
  const current = existsSync(file) ? await readFile(file, "utf8") : "";
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = [...new Set(patterns)].filter((pattern) => !present.has(pattern));
  if (missing.length === 0) return;
  await mkdir(path.dirname(file), { recursive: true });
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await appendFile(file, `${separator}${missing.join("\n")}\n`);
}

/** `git` CLI implementation. Reads use local refs only; fetch and push are the sole network calls. */
export const cliGit: GitOps = {
  async status(path) {
    return { clean: (await mustRun(path, ["status", "--porcelain"])) === "" };
  },
  async revParse(path, ref) {
    const result = await run(path, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return result.exitCode === 0 ? result.stdout : null;
  },
  async aheadBehind(path, branch) {
    const result = await run(path, ["rev-list", "--left-right", "--count", `HEAD...refs/remotes/origin/${branch}`]);
    if (result.exitCode !== 0) return null;
    const counts = result.stdout;
    const [ahead = "0", behind = "0"] = counts.split(/\s+/);
    return { ahead: Number(ahead), behind: Number(behind) };
  },
  async fetch(path, remote, branch) {
    await mustRun(path, ["fetch", remote, branch]);
  },
  async push(path, branch, { forceWithLease }) {
    await mustRun(path, ["push", "--set-upstream", ...(forceWithLease ? ["--force-with-lease"] : []), "origin", branch]);
  },
};

export interface WorktreeInspection {
  /** Null when HEAD is detached or git could not tell. */
  branch: string | null;
  headSha: string | null;
  clean: boolean | null;
  /** The git operation left unfinished in the worktree, with the commit it stopped on (null when git cannot name it); undefined when git could not be read. */
  operation: { kind: "rebase" | "merge" | "cherry-pick"; commit: string | null } | null | undefined;
  /** HEAD against the locally fetched `origin/<base>`; null when that ref is missing. */
  aheadBehind: { ahead: number; behind: number } | null;
}

/** Reads a worktree's state from local git only; every fact git cannot give is null. */
export async function inspectWorktree(workspace: string, baseBranch: string): Promise<WorktreeInspection> {
  const optional = async (args: string[]) => {
    const result = await run(workspace, args).catch(() => null);
    return result && result.exitCode === 0 && result.stdout ? result.stdout : null;
  };
  const gitDir = await optional(["rev-parse", "--absolute-git-dir"]);
  const status = await run(workspace, ["status", "--porcelain"]).catch(() => null);
  const counts = await optional(["rev-list", "--left-right", "--count", `HEAD...refs/remotes/origin/${baseBranch}`]);
  const [ahead, behind] = counts ? counts.split(/\s+/).map(Number) : [];
  let operation: WorktreeInspection["operation"] = undefined;
  if (gitDir) {
    operation = null;
    const verify = (ref: string) => optional(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (existsSync(path.join(gitDir, "rebase-merge")) || existsSync(path.join(gitDir, "rebase-apply"))) {
      const stopped = existsSync(path.join(gitDir, "rebase-merge", "stopped-sha"))
        ? (await readFile(path.join(gitDir, "rebase-merge", "stopped-sha"), "utf8")).trim() : null;
      operation = { kind: "rebase", commit: (await verify("REBASE_HEAD")) ?? (stopped || null) };
    } else if (existsSync(path.join(gitDir, "MERGE_HEAD"))) {
      operation = { kind: "merge", commit: await verify("MERGE_HEAD") };
    } else if (existsSync(path.join(gitDir, "CHERRY_PICK_HEAD"))) {
      operation = { kind: "cherry-pick", commit: await verify("CHERRY_PICK_HEAD") };
    }
  }
  return {
    branch: await optional(["symbolic-ref", "--short", "-q", "HEAD"]),
    headSha: await optional(["rev-parse", "--verify", "--quiet", "HEAD"]),
    clean: status && status.exitCode === 0 ? status.stdout === "" : null,
    operation,
    aheadBehind: counts && Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead: ahead!, behind: behind! } : null,
  };
}
