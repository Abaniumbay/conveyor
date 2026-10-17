import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { GitPushRejectedError, cliGit, ensureGitExcludes } from "../../src/workspace/git";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function sh(cwd: string, ...args: string[]) {
  const p = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
  return out.trim();
}

test("cliGit reports status, heads and ahead/behind from local refs, and push updates origin/<branch>", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-git-"));
  directories.push(root);
  const remote = path.join(root, "remote.git");
  const work = path.join(root, "work");
  await sh(root, "init", "--bare", "-b", "main", remote);
  await sh(root, "clone", remote, work);
  await writeFile(path.join(work, "a"), "1");
  await sh(work, "add", "."); await sh(work, "commit", "-m", "one");
  await sh(work, "checkout", "-b", "feat");

  expect(await cliGit.aheadBehind(work, "feat")).toBeNull();
  expect(await cliGit.revParse(work, "refs/remotes/origin/feat")).toBeNull();
  expect(await cliGit.status(work)).toEqual({ clean: true });
  await writeFile(path.join(work, "b"), "x");
  expect(await cliGit.status(work)).toEqual({ clean: false });

  await cliGit.push(work, "feat", { forceWithLease: false });
  const head = await sh(work, "rev-parse", "HEAD");
  expect(await cliGit.revParse(work, "refs/remotes/origin/feat")).toBe(head);
  expect(await cliGit.aheadBehind(work, "feat")).toEqual({ ahead: 0, behind: 0 });

  await writeFile(path.join(work, "c"), "y");
  await sh(work, "add", "c"); await sh(work, "commit", "-m", "two");
  expect(await cliGit.aheadBehind(work, "feat")).toEqual({ ahead: 1, behind: 0 });
  await cliGit.fetch(work, "origin", "feat");
});

test("cliGit lease push honors an observed head after a server-side update despite a stale tracking ref", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-git-"));
  directories.push(root);
  const remote = path.join(root, "remote.git");
  const work = path.join(root, "work");
  const server = path.join(root, "server");
  await sh(root, "init", "--bare", "-b", "main", remote);
  await sh(root, "clone", remote, work);
  await writeFile(path.join(work, "a"), "1");
  await sh(work, "add", "."); await sh(work, "commit", "-m", "base");
  await sh(work, "checkout", "-b", "feat");
  await cliGit.push(work, "feat", { forceWithLease: false });
  const staleHead = await sh(work, "rev-parse", "HEAD");
  await sh(root, "clone", remote, server);
  await sh(server, "checkout", "feat");
  await writeFile(path.join(server, "server"), "2");
  await sh(server, "add", "."); await sh(server, "commit", "-m", "server update");
  await sh(server, "push", "origin", "feat");
  const observedHead = await sh(server, "rev-parse", "HEAD");

  await writeFile(path.join(work, "local"), "3");
  await sh(work, "add", "."); await sh(work, "commit", "-m", "local update");
  await cliGit.fetch(work, "origin", "feat");
  expect(await cliGit.revParse(work, observedHead)).toBe(observedHead);
  await sh(work, "rebase", observedHead);
  await sh(work, "update-ref", "refs/remotes/origin/feat", staleHead);
  expect(await cliGit.revParse(work, "refs/remotes/origin/feat")).toBe(staleHead);

  await cliGit.push(work, "feat", { forceWithLease: true, expectedRemoteHead: observedHead });
  expect(await sh(root, "--git-dir", remote, "rev-parse", "refs/heads/feat")).toBe(await sh(work, "rev-parse", "HEAD"));
});

test("cliGit treats an observed remote head that has not been fetched as unreconciled", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-git-"));
  directories.push(root);
  const remote = path.join(root, "remote.git");
  const work = path.join(root, "work");
  const server = path.join(root, "server");
  await sh(root, "init", "--bare", "-b", "main", remote);
  await sh(root, "clone", remote, work);
  await writeFile(path.join(work, "a"), "1");
  await sh(work, "add", "."); await sh(work, "commit", "-m", "base");
  await sh(work, "checkout", "-b", "feat");
  await cliGit.push(work, "feat", { forceWithLease: false });
  await sh(root, "clone", remote, server);
  await sh(server, "checkout", "feat");
  await writeFile(path.join(server, "server"), "2");
  await sh(server, "add", "."); await sh(server, "commit", "-m", "server update");
  await sh(server, "push", "origin", "feat");
  const observedHead = await sh(server, "rev-parse", "HEAD");

  expect(await cliGit.revParse(work, observedHead)).toBeNull();
  expect(await cliGit.isAncestor(work, observedHead, "HEAD")).toBe(false);
});

test("cliGit lease push rejects an unseen remote head without overwriting it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-git-"));
  directories.push(root);
  const remote = path.join(root, "remote.git");
  const work = path.join(root, "work");
  const server = path.join(root, "server");
  await sh(root, "init", "--bare", "-b", "main", remote);
  await sh(root, "clone", remote, work);
  await writeFile(path.join(work, "a"), "1");
  await sh(work, "add", "."); await sh(work, "commit", "-m", "base");
  await sh(work, "checkout", "-b", "feat");
  await cliGit.push(work, "feat", { forceWithLease: false });
  const observedHead = await sh(work, "rev-parse", "HEAD");
  await sh(root, "clone", remote, server);
  await sh(server, "checkout", "feat");
  await writeFile(path.join(server, "server"), "2");
  await sh(server, "add", "."); await sh(server, "commit", "-m", "server update");
  await sh(server, "push", "origin", "feat");
  const remoteHead = await sh(server, "rev-parse", "HEAD");
  await writeFile(path.join(work, "local"), "3");
  await sh(work, "add", "."); await sh(work, "commit", "-m", "local update");

  await expect(cliGit.push(work, "feat", { forceWithLease: true, expectedRemoteHead: observedHead }))
    .rejects.toMatchObject({ currentHeadSha: remoteHead } satisfies Partial<GitPushRejectedError>);
  expect(await sh(root, "--git-dir", remote, "rev-parse", "refs/heads/feat")).toBe(remoteHead);
});

test("cliGit lease push rejects when the remote moves during the attempt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-git-"));
  directories.push(root);
  const remote = path.join(root, "remote.git");
  const work = path.join(root, "work");
  const server = path.join(root, "server");
  await sh(root, "init", "--bare", "-b", "main", remote);
  await sh(root, "clone", remote, work);
  await writeFile(path.join(work, "a"), "1");
  await sh(work, "add", "."); await sh(work, "commit", "-m", "base");
  await sh(work, "checkout", "-b", "feat");
  await cliGit.push(work, "feat", { forceWithLease: false });
  const observedHead = await sh(work, "rev-parse", "HEAD");
  await sh(root, "clone", remote, server);
  await sh(server, "checkout", "feat");
  await writeFile(path.join(server, "server"), "2");
  await sh(server, "add", "."); await sh(server, "commit", "-m", "prepared move");
  const movedHead = await sh(server, "rev-parse", "HEAD");
  await sh(server, "push", "origin", "HEAD:refs/heads/prepared-move");
  await writeFile(path.join(work, "local"), "3");
  await sh(work, "add", "."); await sh(work, "commit", "-m", "local update");
  const hook = path.join(work, ".git", "hooks", "pre-push");
  await writeFile(hook, `#!/bin/sh\ngit --git-dir="$2" update-ref refs/heads/feat ${movedHead}\n`);
  await chmod(hook, 0o755);

  await expect(cliGit.push(work, "feat", { forceWithLease: true, expectedRemoteHead: observedHead }))
    .rejects.toMatchObject({ currentHeadSha: movedHead } satisfies Partial<GitPushRejectedError>);
  expect(await sh(root, "--git-dir", remote, "rev-parse", "refs/heads/feat")).toBe(movedHead);
});

test("ensureGitExcludes keeps tool files out of every worktree's status, once, without touching tracked files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-git-"));
  directories.push(root);
  const main = path.join(root, "main");
  const linked = path.join(root, "linked");
  await sh(root, "init", "-b", "main", main);
  await writeFile(path.join(main, "a"), "1");
  await sh(main, "add", "."); await sh(main, "commit", "-m", "one");
  await sh(main, "worktree", "add", "-b", "feat", linked);
  await Bun.write(path.join(linked, ".serena", "project.yml"), "x");
  expect(await cliGit.status(linked)).toEqual({ clean: false });

  await ensureGitExcludes(linked, [".serena/"]);
  await ensureGitExcludes(linked, [".serena/", ".serena/"]);

  expect(await cliGit.status(linked)).toEqual({ clean: true });
  const exclude = await readFile(path.join(main, ".git", "info", "exclude"), "utf8");
  expect(exclude.split("\n").filter((line) => line === ".serena/")).toHaveLength(1);
  expect(await sh(main, "status", "--porcelain")).toBe("");
});

test("ensureGitExcludes does nothing outside a git checkout or without patterns", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-git-"));
  directories.push(root);
  await ensureGitExcludes(root, [".serena/"]);
  await ensureGitExcludes(root, []);
});
