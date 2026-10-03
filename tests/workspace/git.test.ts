import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { cliGit, ensureGitExcludes } from "../../src/workspace/git";

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
