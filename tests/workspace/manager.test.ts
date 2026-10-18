import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { workspaceScratchPath, WorkspaceError, WorkspaceManager } from "../../src/workspace/manager";
import { ConveyorStore } from "../../src/db/store";
import { ensureWorkspace } from "../../src/workspace/lifecycle";

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

async function repositoryWithOrigin(): Promise<{ root: string; checkout: string; workspaces: string }> {
  const fixture = await repository();
  const origin = path.join(fixture.root, "origin.git");
  await command(fixture.root, "git", "init", "--bare", origin);
  await command(fixture.checkout, "git", "remote", "add", "origin", origin);
  await command(fixture.checkout, "git", "push", "-u", "origin", "main");
  return fixture;
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
    expect(existsSync(workspaceScratchPath(workspace.path))).toBe(true);
    expect(workspaceScratchPath(workspace.path)).not.toStartWith(workspace.path + path.sep);
    await rm(workspaceScratchPath(workspace.path), { recursive: true, force: true });
    await manager.ensureScratch(workspace.path);
    expect(existsSync(workspaceScratchPath(workspace.path))).toBe(true);
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
    await command(fixture.checkout, "git", "update-ref", `refs/remotes/origin/${workspace.branch}`, "HEAD");

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
    expect(await command(fixture.checkout, "git", "branch", "-r", "--list", `origin/${workspace.branch}`)).toBe("");
    expect(await readFile(path.join(fixture.checkout, "README.md"), "utf8")).toBe("base\n");
    expect(existsSync(workspaceScratchPath(workspace.path))).toBe(false);
  });

  test("accepts legacy symlink-spelled workspace records", async () => {
    const fixture = await repository();
    await mkdir(fixture.workspaces);
    const legacyRoot = path.join(fixture.root, "legacy-workspaces");
    await symlink(fixture.workspaces, legacyRoot);
    const manager = new WorkspaceManager(legacyRoot);
    const workspace = await manager.create({
      repositoryPath: fixture.checkout,
      repositoryId: "owner-repository",
      issueNumber: 10,
      enrollment: 1,
      slug: "legacy",
      baseBranch: "main",
    });
    const legacyPath = path.join(legacyRoot, "owner-repository", "issue-10-r1");

    await manager.ensureScratch(legacyPath);
    await manager.remove({
      repositoryPath: fixture.checkout,
      workspacePath: legacyPath,
      branch: workspace.branch,
      deleteBranch: true,
    });

    expect(existsSync(workspace.path)).toBe(false);
    expect(existsSync(workspaceScratchPath(workspace.path))).toBe(false);
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
    expect(existsSync(workspaceScratchPath(created.path))).toBe(true);
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

describe("WorkspaceManager.create recovery", () => {
  test("adopts an existing local branch at its unpushed head", async () => {
    const fixture = await repository();
    const manager = new WorkspaceManager(fixture.workspaces);
    const branch = "conveyor/45-r1-recover";
    const base = await command(fixture.checkout, "git", "rev-parse", "HEAD");
    await command(fixture.checkout, "git", "checkout", "-b", branch);
    await writeFile(path.join(fixture.checkout, "recovered.txt"), "kept\n");
    await command(fixture.checkout, "git", "add", "recovered.txt");
    await command(fixture.checkout, "git", "commit", "-m", "saved work");
    const head = await command(fixture.checkout, "git", "rev-parse", "HEAD");
    await command(fixture.checkout, "git", "checkout", "main");

    const workspace = await manager.create({
      repositoryPath: fixture.checkout, repositoryId: "owner-repository", issueNumber: 45, enrollment: 1, slug: "recover", baseBranch: "main",
    });

    expect(workspace.branch).toBe(branch);
    expect(workspace.baseRevision).not.toBe(base);
    expect(await command(workspace.path, "git", "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(path.join(workspace.path, "recovered.txt"), "utf8")).toBe("kept\n");
  });

  test("adopts a dirty registered worktree without touching its changes", async () => {
    const fixture = await repository();
    const manager = new WorkspaceManager(fixture.workspaces);
    const input = {
      repositoryPath: fixture.checkout, repositoryId: "owner-repository", issueNumber: 46, enrollment: 1, slug: "dirty", baseBranch: "main",
    };
    const created = await manager.create(input);
    await writeFile(path.join(created.path, "dirty.txt"), "preserve me\n");

    const adopted = await manager.create(input);

    expect(adopted).toMatchObject({ path: created.path, branch: created.branch });
    expect(await readFile(path.join(created.path, "dirty.txt"), "utf8")).toBe("preserve me\n");
    expect(await command(created.path, "git", "status", "--porcelain")).toContain("dirty.txt");
  });

  test("records a dirty registered worktree and keeps that record on retry", async () => {
    const fixture = await repository();
    const manager = new WorkspaceManager(fixture.workspaces);
    const input = {
      repositoryPath: fixture.checkout, repositoryId: "owner-repository", issueNumber: 46, enrollment: 1, slug: "dirty", baseBranch: "main",
    };
    const created = await manager.create(input);
    await writeFile(path.join(created.path, "dirty.txt"), "preserve me\n");
    const store = await ConveyorStore.open(path.join(fixture.root, "conveyor.sqlite"));
    try {
      store.upsertRepository({ id: "owner-repository", configName: "repository", source: "github", address: "owner/repository", folder: fixture.checkout, configHash: "test" });
      store.upsertIssue({
        id: "issue-46", repositoryId: "owner-repository", sourceNumber: 46, sourceUrl: "https://example.test/issues/46", title: "Dirty", body: "",
        sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
      });

      const adopted = await ensureWorkspace({
        store, manager, issueId: "issue-46", repository: { id: "owner-repository", folder: fixture.checkout, baseBranch: "main" },
      });
      const retried = await ensureWorkspace({
        store, manager, issueId: "issue-46", repository: { id: "owner-repository", folder: fixture.checkout, baseBranch: "main" },
      });

      expect(adopted).toMatchObject({ path: created.path, branch: created.branch, status: "active" });
      expect(retried.id).toBe(adopted.id);
      expect(await readFile(path.join(created.path, "dirty.txt"), "utf8")).toBe("preserve me\n");
    } finally {
      store.close();
    }
  });

  test("fetches and attaches an existing origin-only branch at its existing head", async () => {
    const fixture = await repositoryWithOrigin();
    const manager = new WorkspaceManager(fixture.workspaces);
    const branch = "conveyor/47-r1-remote";
    await command(fixture.checkout, "git", "checkout", "-b", branch);
    await writeFile(path.join(fixture.checkout, "remote.txt"), "kept remotely\n");
    await command(fixture.checkout, "git", "add", "remote.txt");
    await command(fixture.checkout, "git", "commit", "-m", "remote work");
    const head = await command(fixture.checkout, "git", "rev-parse", "HEAD");
    await command(fixture.checkout, "git", "push", "-u", "origin", branch);
    await command(fixture.checkout, "git", "checkout", "main");
    await command(fixture.checkout, "git", "branch", "-D", branch);
    await command(fixture.checkout, "git", "update-ref", "-d", `refs/remotes/origin/${branch}`);

    const store = await ConveyorStore.open(path.join(fixture.root, "conveyor.sqlite"));
    try {
      store.upsertRepository({ id: "owner-repository", configName: "repository", source: "github", address: "owner/repository", folder: fixture.checkout, configHash: "test" });
      store.upsertIssue({
        id: "issue-47", repositoryId: "owner-repository", sourceNumber: 47, sourceUrl: "https://example.test/issues/47", title: "Remote", body: "",
        sourceState: "open", labels: ["conveyor"], sourceUpdatedAt: "2026-01-01T00:00:00Z",
      });

      const workspace = await ensureWorkspace({
        store, manager, issueId: "issue-47", repository: { id: "owner-repository", folder: fixture.checkout, baseBranch: "main" },
      });

      expect(workspace).toMatchObject({ branch, status: "active" });
      expect(await command(workspace.path, "git", "rev-parse", "HEAD")).toBe(head);
      expect(await readFile(path.join(workspace.path, "remote.txt"), "utf8")).toBe("kept remotely\n");
    } finally {
      store.close();
    }
  });

  test("rejects a path occupied by another registered worktree without changing it", async () => {
    const fixture = await repository();
    const manager = new WorkspaceManager(fixture.workspaces);
    const expectedPath = path.join(fixture.workspaces, "owner-repository", "issue-48-r1");
    const otherBranch = "conveyor/48-r1-other";
    await command(fixture.checkout, "git", "worktree", "add", "-b", otherBranch, expectedPath, "HEAD");
    const before = await command(fixture.checkout, "git", "worktree", "list", "--porcelain");

    await expect(manager.create({
      repositoryPath: fixture.checkout, repositoryId: "owner-repository", issueNumber: 48, enrollment: 1, slug: "expected", baseBranch: "main",
    })).rejects.toThrow(new RegExp(`${expectedPath}.*conveyor/48-r1-expected.*${otherBranch}`));

    expect(await command(fixture.checkout, "git", "worktree", "list", "--porcelain")).toBe(before);
    expect(await command(expectedPath, "git", "branch", "--show-current")).toBe(otherBranch);
  });

  test("rejects a non-worktree path and a branch checked out elsewhere without changing either", async () => {
    const fixture = await repository();
    const manager = new WorkspaceManager(fixture.workspaces);
    const expectedPath = path.join(fixture.workspaces, "owner-repository", "issue-49-r1");
    await mkdir(expectedPath, { recursive: true });
    await writeFile(path.join(expectedPath, "occupant.txt"), "keep\n");

    await expect(manager.create({
      repositoryPath: fixture.checkout, repositoryId: "owner-repository", issueNumber: 49, enrollment: 1, slug: "expected", baseBranch: "main",
    })).rejects.toThrow(new RegExp(`${expectedPath}.*conveyor/49-r1-expected.*non-worktree`));
    expect(await readFile(path.join(expectedPath, "occupant.txt"), "utf8")).toBe("keep\n");

    await rm(expectedPath, { recursive: true });
    const elsewhere = path.join(fixture.workspaces, "other");
    const branch = "conveyor/49-r1-expected";
    await command(fixture.checkout, "git", "worktree", "add", "-b", branch, elsewhere, "HEAD");
    const before = await command(fixture.checkout, "git", "worktree", "list", "--porcelain");

    await expect(manager.create({
      repositoryPath: fixture.checkout, repositoryId: "owner-repository", issueNumber: 49, enrollment: 1, slug: "expected", baseBranch: "main",
    })).rejects.toThrow(new RegExp(`${expectedPath}.*${branch}.*${elsewhere}`));
    expect(await command(fixture.checkout, "git", "worktree", "list", "--porcelain")).toBe(before);
  });
});

describe("WorkspaceManager scratch recovery", () => {
  test("removes inactive scratch while preserving the active workspace's sibling directory", async () => {
    const fixture = await repository();
    const manager = new WorkspaceManager(fixture.workspaces);
    const active = await manager.create({
      repositoryPath: fixture.checkout, repositoryId: "repo", issueNumber: 1, enrollment: 1, slug: "active", baseBranch: "main",
    });
    const orphan = path.join(fixture.workspaces, "repo", "issue-2-r1.tmp");
    await mkdir(orphan, { recursive: true });
    await writeFile(path.join(orphan, "leftover"), "x");

    expect(await manager.removeOrphanedScratch([active.path])).toBe(1);
    expect(existsSync(workspaceScratchPath(active.path))).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  });

  test("removes scratch when the worktree was already absent", async () => {
    const fixture = await repository();
    const manager = new WorkspaceManager(fixture.workspaces);
    const workspace = await manager.create({
      repositoryPath: fixture.checkout, repositoryId: "repo", issueNumber: 4, enrollment: 1, slug: "gone", baseBranch: "main",
    });
    await rm(workspace.path, { recursive: true, force: true });

    await manager.remove({ repositoryPath: fixture.checkout, workspacePath: workspace.path, branch: workspace.branch, deleteBranch: true });

    expect(existsSync(workspaceScratchPath(workspace.path))).toBe(false);
  });
});
