import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { GitHubAdapter } from "../../src/source/github/adapter";
import { GitHubCodeHost } from "../../src/source/github/codehost";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A bare origin with `main`, plus a clone whose `feature` branch was cut before `main` moved on. */
async function world(mainChange: { file: string; text: string }) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-base-sync-"));
  roots.push(root);
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  git(root, "init", "--bare", "-b", "main", origin);
  git(root, "clone", origin, work);
  git(work, "config", "user.name", "t");
  git(work, "config", "user.email", "t@e");
  await writeFile(path.join(work, "shared.txt"), "base\n");
  git(work, "add", ".");
  git(work, "commit", "-m", "base");
  git(work, "push", "origin", "main");
  git(work, "checkout", "-b", "feature");
  await writeFile(path.join(work, "feature.txt"), "feature\n");
  git(work, "add", ".");
  git(work, "commit", "-m", "feature work");
  // main moves on after the branch was cut (e.g. a new required workflow lands).
  git(work, "checkout", "main");
  await writeFile(path.join(work, mainChange.file), mainChange.text);
  git(work, "add", ".");
  git(work, "commit", "-m", "main moves on");
  git(work, "push", "origin", "main");
  git(work, "checkout", "feature");
  return { work, origin, host: new GitHubCodeHost({} as GitHubAdapter) };
}

describe("GitHub CodeHost base synchronization", () => {
  test("merges the moved base into the branch before pushing, so the pushed head contains it", async () => {
    const { work, host } = await world({ file: ".github-full-suite.yml", text: "on: pull_request\n" });
    await expect(host.pushBranch({ address: "owner/repo", workspace: { path: work, branch: "feature" }, base: "main" }))
      .resolves.toEqual({ pushed: true });
    git(work, "fetch", "origin");
    // origin/feature now contains origin/main, and the branch's own work is kept.
    expect(Bun.spawnSync(["git", "merge-base", "--is-ancestor", "origin/main", "origin/feature"], { cwd: work }).exitCode).toBe(0);
    expect(git(work, "show", "origin/feature:feature.txt")).toBe("feature");
    expect(git(work, "show", "origin/feature:.github-full-suite.yml")).toBe("on: pull_request");
  });

  test("a conflict with the base aborts the merge, pushes nothing and asks implementation to resolve it", async () => {
    const { work, host } = await world({ file: "feature.txt", text: "main's version\n" });
    const result = await host.pushBranch({ address: "owner/repo", workspace: { path: work, branch: "feature" }, base: "main" });
    expect(result).toMatchObject({ pushed: false, status: "changes-requested" });
    expect(result.pushed ? "" : result.reason).toContain("feature.txt");
    expect(result.pushed ? "" : result.reason).toContain("origin/main");
    expect(git(work, "status", "--porcelain")).toBe("");
    expect(Bun.spawnSync(["git", "rev-parse", "--verify", "origin/feature"], { cwd: work, stderr: "pipe" }).exitCode).not.toBe(0);
  });

  test("a branch already containing its base is pushed unchanged", async () => {
    const { work, host } = await world({ file: "other.txt", text: "x\n" });
    git(work, "merge", "--no-edit", "origin/main");
    const head = git(work, "rev-parse", "HEAD");
    await expect(host.pushBranch({ address: "owner/repo", workspace: { path: work, branch: "feature" }, base: "main" }))
      .resolves.toEqual({ pushed: true });
    expect(git(work, "rev-parse", "HEAD")).toBe(head);
  });
});
