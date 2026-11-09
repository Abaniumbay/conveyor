// Fails a pull request that removes or renames a public name (docs/public-surface.txt) unless one of
// its changelog fragments is marked `breaking: true`.
//   bun run scripts/check-breaking-changes.ts --base origin/main

import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseChangelogFragment } from "./changelog-fragments";
import { parsePublicSurface } from "./generate-public-surface";

const SURFACE = "docs/public-surface.txt";

export interface BreakingChangeResult {
  passed: boolean;
  /** Surface lines on the base that the head no longer has. */
  removed: string[];
  /** Fragments this pull request adds or changes that are marked breaking. */
  breakingFragments: string[];
  message: string;
}

function git(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function mustGit(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** Compares the head checkout in `cwd` with where it branched from `base`. */
export async function checkBreakingChanges(cwd: string, base: string): Promise<BreakingChangeResult> {
  const mergeBase = mustGit(cwd, ["merge-base", base, "HEAD"]).trim();
  const before = git(cwd, ["show", `${mergeBase}:${SURFACE}`]);
  // A base without the file predates this check: there is nothing to compare with.
  if (before.code !== 0) return { passed: true, removed: [], breakingFragments: [], message: `${SURFACE} is new; nothing to compare.` };
  const after = new Set(parsePublicSurface(await readFile(path.join(cwd, SURFACE), "utf8")));
  const removed = parsePublicSurface(before.stdout).filter((line) => !after.has(line));

  const changedFragments = mustGit(cwd, ["diff", "--name-only", "--diff-filter=AMR", mergeBase, "HEAD", "--", "changes/"])
    .split("\n").map((line) => line.trim()).filter((line) => line.endsWith(".md"));
  const breakingFragments: string[] = [];
  for (const file of changedFragments) {
    const name = path.basename(file);
    if (!/^\d/.test(name)) continue;
    const fragment = parseChangelogFragment(name, await readFile(path.join(cwd, file), "utf8"));
    if (fragment.breaking) breakingFragments.push(file);
  }

  if (removed.length === 0) return { passed: true, removed, breakingFragments, message: "No public name was removed or renamed." };
  if (breakingFragments.length > 0) {
    return { passed: true, removed, breakingFragments, message: `${removed.length} public name(s) removed or renamed; marked breaking in ${breakingFragments.join(", ")}.` };
  }
  return {
    passed: false,
    removed,
    breakingFragments,
    message: [
      `These public names were removed or renamed (${SURFACE}), and no changelog fragment in this pull request is marked \`breaking: true\`:`,
      "",
      ...removed.map((line) => `  - ${line}`),
      "",
      "Installations, scripts or agents that use them break on upgrade. Either mark the fragment that describes the change",
      "with `breaking: true` (and say in it what operators must change), or keep the old name working as deprecated.",
    ].join("\n"),
  };
}

if (import.meta.main) {
  const index = Bun.argv.indexOf("--base");
  const base = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!base) {
    console.error("usage: bun run scripts/check-breaking-changes.ts --base <ref>");
    process.exit(2);
  }
  const result = await checkBreakingChanges(process.cwd(), base);
  (result.passed ? console.log : console.error)(result.message);
  if (!result.passed) process.exitCode = 1;
}
