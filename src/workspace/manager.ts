import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

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
}

export interface RemoveWorkspaceInput {
  repositoryPath: string;
  workspacePath: string;
  branch: string;
  deleteBranch: boolean;
}

export class WorkspaceError extends Error {
  override readonly name = "WorkspaceError";
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
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

export class WorkspaceManager {
  readonly #root: string;

  constructor(root: string) {
    if (!path.isAbsolute(root)) {
      throw new WorkspaceError("workspace root must be an absolute path");
    }
    this.#root = path.resolve(root);
  }

  async create(input: CreateWorkspaceInput): Promise<ManagedWorkspace> {
    const repositoryPath = await this.validateRepository(input.repositoryPath);
    if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0) {
      throw new WorkspaceError("issue number must be a positive integer");
    }
    if (!Number.isSafeInteger(input.enrollment) || input.enrollment <= 0) {
      throw new WorkspaceError("enrollment generation must be a positive integer");
    }

    await mkdir(this.#root, { recursive: true });
    const repositorySegment = safeSegment(input.repositoryId, "repository");
    const workspacePath = path.join(
      this.#root,
      repositorySegment,
      `issue-${input.issueNumber}-r${input.enrollment}`,
    );
    this.assertManagedPath(workspacePath);
    await mkdir(path.dirname(workspacePath), { recursive: true });

    const branch = `conveyor/${input.issueNumber}-r${input.enrollment}-${safeSegment(input.slug, "issue")}`;
    let baseReference = input.baseBranch;
    const remote = await git(repositoryPath, ["remote", "get-url", "origin"]);
    if (remote.exitCode === 0) {
      const fetched = await git(repositoryPath, [
        "fetch",
        "--prune",
        "origin",
        input.baseBranch,
      ]);
      if (fetched.exitCode !== 0) {
        throw new WorkspaceError(
          `cannot fetch origin/${input.baseBranch}: ${fetched.stderr || "unknown Git error"}`,
        );
      }
      baseReference = `refs/remotes/origin/${input.baseBranch}`;
    }

    const revision = await git(repositoryPath, ["rev-parse", "--verify", baseReference]);
    if (revision.exitCode !== 0) {
      throw new WorkspaceError(
        `base branch "${input.baseBranch}" is unavailable: ${revision.stderr || "unknown Git error"}`,
      );
    }

    const created = await git(repositoryPath, [
      "worktree",
      "add",
      "-b",
      branch,
      workspacePath,
      revision.stdout,
    ]);
    if (created.exitCode !== 0) {
      throw new WorkspaceError(
        `cannot create worktree ${workspacePath}: ${created.stderr || "unknown Git error"}`,
      );
    }

    return { path: workspacePath, branch, baseRevision: revision.stdout };
  }

  async remove(input: RemoveWorkspaceInput): Promise<void> {
    const repositoryPath = await this.validateRepository(input.repositoryPath);
    const workspacePath = path.resolve(input.workspacePath);
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

    if (input.deleteBranch) {
      const deleted = await git(repositoryPath, ["branch", "-D", input.branch]);
      if (deleted.exitCode !== 0 && !/not found|not exist/i.test(deleted.stderr)) {
        throw new WorkspaceError(
          `worktree was removed but local branch ${input.branch} could not be deleted: ${deleted.stderr}`,
        );
      }
    }
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
    const relative = path.relative(this.#root, path.resolve(candidate));
    if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new WorkspaceError(`path is outside the workspace root: ${candidate}`);
    }
  }
}
