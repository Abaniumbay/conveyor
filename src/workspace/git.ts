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
