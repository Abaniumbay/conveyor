import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { resolveFilesystemPath } from "../core/paths";

export interface CreateWorkspaceInput {
  repositoryPath: string;
  repositoryId: string;
  issueNumber: number;
  enrollment: number;
  slug: string;
  baseBranch: string;
}

export interface ManagedWorkspace {
  path: string;
  branch: string;
  baseRevision: string;
  /** True when an existing worktree or branch was attached rather than created from base. */
  adopted?: boolean;
}

export interface RemoveWorkspaceInput {
  repositoryPath: string;
  workspacePath: string;
  branch: string;
  deleteBranch: boolean;
}

/** The persistent scratch directory paired with a managed worktree. */
export function workspaceScratchPath(workspacePath: string): string {
  return `${resolveFilesystemPath(workspacePath)}.tmp`;
}

export class WorkspaceError extends Error {
  override readonly name = "WorkspaceError";
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface RegisteredWorktree {
  path: string;
  branch: string | null;
  head: string | null;
}

async function git(cwd: string, args: string[]): Promise<CommandResult> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function safeSegment(value: string, fallback: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return normalized || fallback;
}

function registeredWorktrees(output: string): RegisteredWorktree[] {
  const worktrees: RegisteredWorktree[] = [];
  let current: Partial<RegisteredWorktree> = {};
  const commit = () => {
    if (current.path) worktrees.push({ path: resolveFilesystemPath(current.path), branch: current.branch ?? null, head: current.head ?? null });
    current = {};
  };
  for (const line of output.split("\n")) {
    if (!line) {
      commit();
      continue;
    }
    if (line.startsWith("worktree ")) current.path = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/")) current.branch = line.slice("branch refs/heads/".length);
    else if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
  }
  commit();
  return worktrees;
}

export class WorkspaceManager {
  readonly #root: string;

  constructor(root: string) {
    if (!path.isAbsolute(root)) {
      throw new WorkspaceError("workspace root must be an absolute path");
    }
    this.#root = resolveFilesystemPath(root);
  }

  async create(input: CreateWorkspaceInput): Promise<ManagedWorkspace> {
    const repositoryPath = await this.validateRepository(input.repositoryPath);
    if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0) {
      throw new WorkspaceError("issue number must be a positive integer");
    }
    if (!Number.isSafeInteger(input.enrollment) || input.enrollment <= 0) {
      throw new WorkspaceError("enrollment generation must be a positive integer");
    }

    const repositorySegment = safeSegment(input.repositoryId, "repository");
    const workspacePath = path.join(
      this.#root,
      repositorySegment,
      `issue-${input.issueNumber}-r${input.enrollment}`,
    );
    this.assertManagedPath(workspacePath);
    const branch = `conveyor/${input.issueNumber}-r${input.enrollment}-${safeSegment(input.slug, "issue")}`;
    const resolvedWorkspacePath = resolveFilesystemPath(workspacePath);
    const listed = await git(repositoryPath, ["worktree", "list", "--porcelain"]);
    if (listed.exitCode !== 0) {
      throw new WorkspaceError(`cannot list worktrees: ${listed.stderr || "unknown Git error"}`);
    }
    const worktrees = registeredWorktrees(listed.stdout);
    const atPath = worktrees.find((worktree) => worktree.path === resolvedWorkspacePath);
    if (atPath && atPath.branch !== branch) {
      const occupant = atPath.branch ? `registered worktree on branch "${atPath.branch}"` : "registered detached worktree";
      throw new WorkspaceError(`cannot adopt workspace ${resolvedWorkspacePath} for branch "${branch}": path contains ${occupant}`);
    }
    if (atPath && !existsSync(resolvedWorkspacePath)) {
      const pruned = await git(repositoryPath, ["worktree", "prune"]);
      if (pruned.exitCode !== 0) {
        throw new WorkspaceError(`cannot prune missing worktree ${resolvedWorkspacePath}: ${pruned.stderr || "unknown Git error"}`);
      }
    }
    if (!atPath && existsSync(resolvedWorkspacePath)) {
      throw new WorkspaceError(`cannot adopt workspace ${resolvedWorkspacePath} for branch "${branch}": path is occupied by a non-worktree directory`);
    }
    const branchElsewhere = worktrees.find((worktree) => worktree.branch === branch && worktree.path !== resolvedWorkspacePath);
    if (branchElsewhere) {
      throw new WorkspaceError(`cannot adopt workspace ${resolvedWorkspacePath} for branch "${branch}": branch is checked out at ${branchElsewhere.path}`);
    }
    if (atPath && existsSync(resolvedWorkspacePath)) {
      await this.ensureScratch(resolvedWorkspacePath);
      const head = atPath.head ?? (await git(repositoryPath, ["rev-parse", "--verify", `refs/heads/${branch}`])).stdout;
      return { path: resolvedWorkspacePath, branch, baseRevision: head, adopted: true };
    }

    const localBranch = await git(repositoryPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (localBranch.exitCode !== 0 && await this.fetchRemoteBranch(repositoryPath, branch)) {
      const created = await git(repositoryPath, ["branch", "--track", branch, `refs/remotes/origin/${branch}`]);
      if (created.exitCode !== 0) {
        throw new WorkspaceError(`cannot create local branch "${branch}" from origin: ${created.stderr || "unknown Git error"}`);
      }
    }

    await mkdir(this.#root, { recursive: true });
    await mkdir(path.dirname(workspacePath), { recursive: true });
    if (localBranch.exitCode === 0 || (await git(repositoryPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).exitCode === 0) {
      const attached = await git(repositoryPath, ["worktree", "add", workspacePath, branch]);
      if (attached.exitCode !== 0) {
        throw new WorkspaceError(`cannot attach worktree ${workspacePath}: ${attached.stderr || "unknown Git error"}`);
      }
      await this.ensureScratch(workspacePath);
      return { path: resolvedWorkspacePath, branch, baseRevision: (await git(workspacePath, ["rev-parse", "HEAD"])).stdout, adopted: true };
    }

    const revision = await this.resolveBase(repositoryPath, input.baseBranch);

    const created = await git(repositoryPath, [
      "worktree",
      "add",
      "-b",
      branch,
      workspacePath,
      revision,
    ]);
    if (created.exitCode !== 0) {
      throw new WorkspaceError(
        `cannot create worktree ${workspacePath}: ${created.stderr || "unknown Git error"}`,
      );
    }

    await this.ensureScratch(workspacePath);

    return { path: resolveFilesystemPath(workspacePath), branch, baseRevision: revision, adopted: false };
  }

  /** Fetches a branch only when origin has it; a missing branch is a normal fresh-workspace case. */
  private async fetchRemoteBranch(repositoryPath: string, branch: string): Promise<boolean> {
    const remote = await git(repositoryPath, ["remote", "get-url", "origin"]);
    if (remote.exitCode !== 0) return false;
    const fetched = await git(repositoryPath, ["fetch", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    if (fetched.exitCode === 0) return true;
    if (/couldn't find remote ref|remote ref does not exist|not found/i.test(fetched.stderr)) return false;
    throw new WorkspaceError(`cannot fetch origin/${branch}: ${fetched.stderr || "unknown Git error"}`);
  }

  /**
   * Re-attaches the recorded workspace path after its directory went missing. The local
   * branch is never deleted: it may hold unpushed commits. When it no longer exists it is
   * created fresh from the base branch.
   */
  async restore(input: {
    repositoryPath: string;
    workspacePath: string;
    branch: string;
    baseBranch: string;
  }): Promise<void> {
    const repositoryPath = await this.validateRepository(input.repositoryPath);
    const workspacePath = resolveFilesystemPath(input.workspacePath);
    this.assertManagedPath(workspacePath);
    await git(repositoryPath, ["worktree", "prune"]);
    await mkdir(path.dirname(workspacePath), { recursive: true });
    const branchExists =
      (await git(repositoryPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${input.branch}`])).exitCode === 0;
    const args = branchExists
      ? ["worktree", "add", workspacePath, input.branch]
      : ["worktree", "add", "-b", input.branch, workspacePath, await this.resolveBase(repositoryPath, input.baseBranch)];
    const added = await git(repositoryPath, args);
    if (added.exitCode !== 0) {
      throw new WorkspaceError(`cannot restore worktree ${workspacePath}: ${added.stderr || "unknown Git error"}`);
    }
    await this.ensureScratch(workspacePath);
  }

  /** Ensure the persistent, sibling scratch directory remains available for an active workspace. */
  async ensureScratch(workspacePath: string): Promise<void> {
    const resolved = resolveFilesystemPath(workspacePath);
    this.assertManagedPath(resolved);
    await mkdir(workspaceScratchPath(resolved), { recursive: true });
  }

  private async resolveBase(repositoryPath: string, baseBranch: string): Promise<string> {
    let baseReference = baseBranch;
    const remote = await git(repositoryPath, ["remote", "get-url", "origin"]);
    if (remote.exitCode === 0) {
      const fetched = await git(repositoryPath, [
        "fetch",
        "--prune",
        "origin",
        baseBranch,
      ]);
      if (fetched.exitCode !== 0) {
        throw new WorkspaceError(
          `cannot fetch origin/${baseBranch}: ${fetched.stderr || "unknown Git error"}`,
        );
      }
      baseReference = `refs/remotes/origin/${baseBranch}`;
    }

    const revision = await git(repositoryPath, ["rev-parse", "--verify", baseReference]);
    if (revision.exitCode !== 0) {
      throw new WorkspaceError(
        `base branch "${baseBranch}" is unavailable: ${revision.stderr || "unknown Git error"}`,
      );
    }

    return revision.stdout;
  }

  async remove(input: RemoveWorkspaceInput): Promise<void> {
    const repositoryPath = await this.validateRepository(input.repositoryPath);
    const workspacePath = resolveFilesystemPath(input.workspacePath);
    this.assertManagedPath(workspacePath);
    if (!input.branch.startsWith("conveyor/")) {
      throw new WorkspaceError(
        `refusing to delete unmanaged branch "${input.branch}"`,
      );
    }

    const removed = await git(repositoryPath, [
      "worktree",
      "remove",
      "--force",
      workspacePath,
    ]);
    if (removed.exitCode !== 0 && !/is not a working tree|does not exist/i.test(removed.stderr)) {
      throw new WorkspaceError(
        `cannot remove worktree ${workspacePath}: ${removed.stderr || "unknown Git error"}`,
      );
    }
    await git(repositoryPath, ["worktree", "prune"]);
    await rm(workspaceScratchPath(workspacePath), { recursive: true, force: true });

    if (input.deleteBranch) {
      const deleted = await git(repositoryPath, ["branch", "-D", input.branch]);
      if (deleted.exitCode !== 0 && !/not found|not exist/i.test(deleted.stderr)) {
        throw new WorkspaceError(
          `worktree was removed but local branch ${input.branch} could not be deleted: ${deleted.stderr}`,
        );
      }
      // The stale remote-tracking ref goes too (absent is fine); the remote branch itself is the code host's.
      await git(repositoryPath, ["update-ref", "-d", `refs/remotes/origin/${input.branch}`]);
    }
  }

  /** Remove scratch directories whose workspaces are no longer active after a service restart. */
  async removeOrphanedScratch(activeWorkspacePaths: readonly string[]): Promise<number> {
    const active = new Set(activeWorkspacePaths.map(workspaceScratchPath));
    let repositories: Dirent<string>[];
    try {
      repositories = await readdir(this.#root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let removed = 0;
    for (const repository of repositories) {
      if (!repository.isDirectory()) continue;
      const repositoryPath = path.join(this.#root, repository.name);
      for (const entry of await readdir(repositoryPath, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.endsWith(".tmp")) continue;
        const scratch = path.join(repositoryPath, entry.name);
        this.assertManagedPath(scratch.slice(0, -".tmp".length));
        if (active.has(scratch)) continue;
        await rm(scratch, { recursive: true, force: true });
        removed += 1;
      }
    }
    return removed;
  }

  private async validateRepository(repositoryPath: string): Promise<string> {
    let resolved: string;
    try {
      resolved = await realpath(repositoryPath);
    } catch {
      throw new WorkspaceError(`repository folder does not exist: ${repositoryPath}`);
    }
    const topLevel = await git(resolved, ["rev-parse", "--show-toplevel"]);
    if (topLevel.exitCode !== 0) {
      throw new WorkspaceError(
        `configured folder is not a Git checkout: ${repositoryPath}`,
      );
    }
    const actualTopLevel = await realpath(topLevel.stdout);
    if (actualTopLevel !== resolved) {
      throw new WorkspaceError(
        `configured folder must be the checkout root; Git root is ${actualTopLevel}`,
      );
    }
    return resolved;
  }

  private assertManagedPath(candidate: string): void {
    const resolved = resolveFilesystemPath(candidate);
    const relative = path.relative(this.#root, resolved);
    if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new WorkspaceError(`path is outside the workspace root: ${candidate}`);
    }
  }
}
