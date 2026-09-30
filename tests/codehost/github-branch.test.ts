import { describe, expect, test } from "bun:test";

import { GitHubCodeHost } from "../../src/source/github/codehost";
import type { GitHubAdapter } from "../../src/source/github/adapter";

type Mode = "aligned" | "behind" | "diverged" | "dirty" | "missing";

function fixture(mode: Mode) {
  const calls: string[][] = [];
  const git = async (_cwd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "fetch" && mode === "missing") return { stdout: "", stderr: "couldn't find remote ref", exitCode: 128 };
    if (args[0] === "fetch") return { stdout: "", stderr: "", exitCode: 0 };
    if (args[0] === "merge-base") {
      const ok = mode === "aligned" || ((mode === "behind" || mode === "dirty") && args[2] === "HEAD");
      return { stdout: "", stderr: "", exitCode: ok ? 0 : 1 };
    }
    if (args[0] === "status") return { stdout: mode === "dirty" ? " M file" : "", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const host = new GitHubCodeHost({} as GitHubAdapter, git);
  return { host, calls };
}

describe("GitHub CodeHost branch synchronization", () => {
  test("pushes aligned and first-push branches", async () => {
    for (const mode of ["aligned", "missing"] as const) {
      const { host, calls } = fixture(mode);
      await expect(host.pushBranch({ address: "owner/repo", workspace: { path: "/tmp/work", branch: "feature" } }))
        .resolves.toEqual({ pushed: true });
      expect(calls.at(-1)).toEqual(["push", "--set-upstream", "origin", "feature"]);
    }
  });

  test("fast-forwards a clean local branch behind its remote", async () => {
    const { host, calls } = fixture("behind");
    await expect(host.pushBranch({ address: "owner/repo", workspace: { path: "/tmp/work", branch: "feature" } }))
      .resolves.toEqual({ pushed: true });
    expect(calls).toContainEqual(["merge", "--ff-only", "origin/feature"]);
  });

  test("returns changes-requested for diverged or dirty-behind work without pushing", async () => {
    for (const mode of ["diverged", "dirty"] as const) {
      const { host, calls } = fixture(mode);
      await expect(host.pushBranch({ address: "owner/repo", workspace: { path: "/tmp/work", branch: "feature" } }))
        .resolves.toMatchObject({ pushed: false, status: "changes-requested" });
      expect(calls.some((args) => args[0] === "push")).toBe(false);
    }
  });
});
