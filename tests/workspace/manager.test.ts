import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkspaceError, WorkspaceManager } from "../../src/workspace/manager";

const temporaryDirectories: string[] = [];

async function command(cwd: string, ...args: string[]): Promise<string> {
  const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args.join(" ")}: ${stderr}`);
  return stdout.trim();
}

async function repository(): Promise<{ root: string; checkout: string; workspaces: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-workspace-"));
  temporaryDirectories.push(root);
  const checkout = path.join(root, "repository");
  const workspaces = path.join(root, "workspaces");
  await mkdir(checkout);
  await command(checkout, "git", "init", "-b", "main");
  await command(checkout, "git", "config", "user.name", "Conveyor Test");
  await command(checkout, "git", "config", "user.email", "conveyor@example.test");
  await writeFile(path.join(checkout, "README.md"), "base\n");
  await command(checkout, "git", "add", "README.md");
  await command(checkout, "git", "commit", "-m", "initial");
  return { root, checkout, workspaces };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("WorkspaceManager", () => {
  test("creates an issue worktree without changing the primary checkout", async () => {
    const fixture = await repository();
    const manager = new WorkspaceManager(fixture.workspaces);
    const originalHead = await command(fixture.checkout, "git", "rev-parse", "HEAD");

    const workspace = await manager.create({
      repositoryPath: fixture.checkout,
      repositoryId: "owner-repository",
      issueNumber: 42,
      enrollment: 1,
      slug: "Beautiful feature!",
      baseBranch: "main",
    });

    expect(workspace.branch).toBe("conveyor/42-r1-beautiful-feature");
    expect(workspace.path).toStartWith(fixture.workspaces);
    expect(await readFile(path.join(workspace.path, "README.md"), "utf8")).toBe("base\n");
    expect(await command(fixture.checkout, "git", "branch", "--show-current")).toBe("main");
    expect(await command(fixture.checkout, "git", "rev-parse", "HEAD")).toBe(originalHead);
    expect(await command(fixture.checkout, "git", "status", "--porcelain")).toBe("");
  });

  test("keeps worktree edits isolated and removes only managed paths", async () => {
    const fixture = await repository();
    const manager = new WorkspaceManager(fixture.workspaces);
    const workspace = await manager.create({
      repositoryPath: fixture.checkout,
      repositoryId: "owner-repository",
      issueNumber: 9,
      enrollment: 2,
      slug: "fix",
      baseBranch: "main",
    });
    await writeFile(path.join(workspace.path, "README.md"), "changed\n");

    expect(await readFile(path.join(fixture.checkout, "README.md"), "utf8")).toBe("base\n");

    await manager.remove({
      repositoryPath: fixture.checkout,
      workspacePath: workspace.path,
      branch: workspace.branch,
      deleteBranch: true,
    });

    expect(await command(fixture.checkout, "git", "worktree", "list", "--porcelain")).not.toContain(
      workspace.path,
    );
    expect(await command(fixture.checkout, "git", "branch", "--list", workspace.branch)).toBe("");
    expect(await readFile(path.join(fixture.checkout, "README.md"), "utf8")).toBe("base\n");
  });

  test("rejects a configured folder that is not a Git checkout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-not-git-"));
    temporaryDirectories.push(root);
    const manager = new WorkspaceManager(path.join(root, "workspaces"));

    await expect(
      manager.create({
        repositoryPath: root,
        repositoryId: "broken",
        issueNumber: 1,
        enrollment: 1,
        slug: "test",
        baseBranch: "main",
      }),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });
});

describe("WorkspaceManager.restore", () => {
  const input = (r: { checkout: string }, created: { path: string; branch: string }) => ({
    repositoryPath: r.checkout, workspacePath: created.path, branch: created.branch, baseBranch: "main",
  });
  const make = async () => {
    const r = await repository();
    const manager = new WorkspaceManager(r.workspaces);
    const created = await manager.create({
      repositoryPath: r.checkout, repositoryId: "repo", issueNumber: 3, enrollment: 1, slug: "x", baseBranch: "main",
    });
    return { r, manager, created };
  };

  test("re-attaches the existing branch at the recorded path and keeps an unpushed commit", async () => {
    const { r, manager, created } = await make();
    await command(created.path, "git", "config", "user.name", "T");
    await command(created.path, "git", "config", "user.email", "t@example.test");
    await writeFile(path.join(created.path, "work.txt"), "w\n");
    await command(created.path, "git", "add", ".");
    await command(created.path, "git", "commit", "-m", "unpushed");
    const head = await command(created.path, "git", "rev-parse", "HEAD");
    await rm(created.path, { recursive: true });

    await manager.restore(input(r, created));

    expect(await command(created.path, "git", "rev-parse", "HEAD")).toBe(head);
    expect(await command(created.path, "git", "branch", "--show-current")).toBe(created.branch);
    expect(await readFile(path.join(created.path, "work.txt"), "utf8")).toBe("w\n");
  });

  test("creates the branch fresh from the base branch when it no longer exists", async () => {
    const { r, manager, created } = await make();
    await rm(created.path, { recursive: true });
    await command(r.checkout, "git", "worktree", "prune");
    await command(r.checkout, "git", "branch", "-D", created.branch);

    await manager.restore(input(r, created));

    expect(await command(created.path, "git", "branch", "--show-current")).toBe(created.branch);
    expect(await command(created.path, "git", "rev-parse", "HEAD")).toBe(created.baseRevision);
  });
});
