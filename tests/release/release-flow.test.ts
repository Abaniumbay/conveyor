import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { nextVersions, ReleaseCheckError, startRelease, tagRelease, type ReleaseIo } from "../../scripts/release";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const CHANGELOG = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- The standalone release.\n";

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A clone of a bare origin whose main has version 0.1.0 and unreleased changes. */
async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-release-flow-"));
  directories.push(root);
  const origin = path.join(root, "origin.git");
  const clone = path.join(root, "clone");
  git(root, "init", "--quiet", "--bare", "--initial-branch", "main", origin);
  git(root, "clone", "--quiet", origin, clone);
  git(clone, "switch", "--quiet", "--create", "main");
  await writeFile(path.join(clone, "package.json"), '{\n  "name": "conveyor",\n  "version": "0.1.0"\n}\n');
  await writeFile(path.join(clone, "CHANGELOG.md"), CHANGELOG);
  git(clone, "add", ".");
  git(clone, "commit", "--quiet", "--message", "initial");
  git(clone, "push", "--quiet", "--set-upstream", "origin", "main");
  return { root, origin, clone };
}

/** Real git in the clone; gh and the terminal are scripted. */
function io(clone: string, answers: Array<string | null> = []) {
  const printed: string[] = [];
  const pullRequests: Array<{ argv: string[]; body: string }> = [];
  const environment = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const releaseIo: ReleaseIo = {
    async run(argv, options = {}) {
      if (argv[0] === "gh") {
        if (argv[1] === "pr" && argv[2] === "create") {
          pullRequests.push({ argv, body: options.stdin ?? "" });
          return { code: 0, stdout: "https://github.com/owner/conveyor/pull/7\n", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      const child = Bun.spawnSync(argv, { cwd: clone, stdout: "pipe", stderr: "pipe", env: environment });
      return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
    },
    ask: async () => (answers.length > 0 ? answers.shift()! : null),
    askText: async () => (answers.length > 0 ? answers.shift()! : null),
    print: (text) => printed.push(text),
    today: () => "2026-10-06",
  };
  return { releaseIo, printed, pullRequests };
}

describe("bun run release start", () => {
  test("asks for the version and summary, prepares the release on a branch and opens its pull request", async () => {
    const { clone, origin } = await repository();
    const { releaseIo, printed, pullRequests } = io(clone, ["0.2.0", "The first standalone release.\nInstall it with install.sh.", "y"]);
    const url = await startRelease({ root: clone }, releaseIo);

    expect(url).toBe("https://github.com/owner/conveyor/pull/7");
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("release/v0.2.0");
    expect(git(clone, "log", "-1", "--format=%s")).toBe("chore(release): v0.2.0");
    expect(git(origin, "rev-parse", "release/v0.2.0")).toBe(git(clone, "rev-parse", "HEAD"));
    expect(JSON.parse(await readFile(path.join(clone, "package.json"), "utf8"))).toEqual({ name: "conveyor", version: "0.2.0" });
    expect(await readFile(path.join(clone, "CHANGELOG.md"), "utf8")).toBe(
      "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-10-06\n\nThe first standalone release.\nInstall it with install.sh.\n\n### Added\n\n- The standalone release.\n",
    );
    expect(pullRequests[0]!.argv).toEqual(["gh", "pr", "create", "--base", "main", "--head", "release/v0.2.0", "--title", "Release v0.2.0", "--body-file", "-"]);
    expect(pullRequests[0]!.body).toContain("## Release notes\n\nThe first standalone release.");
    expect(pullRequests[0]!.body).toContain("bun run release tag 0.2.0");
    expect(printed.join("\n")).toContain("- The standalone release.");
  });

  test("an agent passes everything as options", async () => {
    const { clone } = await repository();
    const { releaseIo, pullRequests } = io(clone);
    await startRelease({ root: clone, version: "0.2.0", summary: "Automated release.", yes: true }, releaseIo);
    expect(pullRequests).toHaveLength(1);
    expect(git(clone, "show", "HEAD:package.json")).toContain('"version": "0.2.0"');
  });

  test("declining, or having no terminal, changes nothing", async () => {
    const { clone } = await repository();
    await expect(startRelease({ root: clone }, io(clone, ["0.2.0", "Summary.", "n"]).releaseIo)).rejects.toThrow("stopped; nothing was changed");
    await expect(startRelease({ root: clone, version: "0.2.0" }, io(clone).releaseIo)).rejects.toThrow("pass --summary");
    await expect(startRelease({ root: clone, version: "0.2.0", summary: "s" }, io(clone).releaseIo)).rejects.toThrow("pass --yes");
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(clone, "status", "--porcelain")).toBe("");
  });

  test("refuses unless the checkout is a clean, current main and the version is new", async () => {
    const { clone, root } = await repository();
    const run = (options: Partial<Parameters<typeof startRelease>[0]> = {}) =>
      startRelease({ root: clone, version: "0.2.0", summary: "s", yes: true, ...options }, io(clone).releaseIo);

    await expect(run({ version: "0.1.0" })).rejects.toThrow("is not later than the current version 0.1.0");

    await writeFile(path.join(clone, "scratch.txt"), "x");
    await expect(run()).rejects.toThrow("uncommitted changes");
    await rm(path.join(clone, "scratch.txt"));

    git(clone, "switch", "--quiet", "--create", "feature");
    await expect(run()).rejects.toThrow("releases start from main, not feature");
    git(clone, "switch", "--quiet", "main");

    const other = path.join(root, "other");
    git(root, "clone", "--quiet", path.join(root, "origin.git"), other);
    await writeFile(path.join(other, "x.txt"), "x");
    git(other, "add", ".");
    git(other, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--message", "elsewhere");
    git(other, "push", "--quiet");
    await expect(run()).rejects.toThrow("not level with origin/main");
    git(clone, "pull", "--quiet", "--ff-only");

    await writeFile(path.join(clone, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n");
    git(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--all", "--message", "empty");
    git(clone, "push", "--quiet");
    await expect(run()).rejects.toThrow("no Unreleased changes");
  });
});

describe("bun run release tag", () => {
  async function merged() {
    const repo = await repository();
    await startRelease({ root: repo.clone, version: "0.2.0", summary: "The first standalone release.", yes: true }, io(repo.clone).releaseIo);
    // The release pull request merges into main.
    git(repo.clone, "push", "--quiet", "origin", "release/v0.2.0:main");
    git(repo.clone, "switch", "--quiet", "main");
    return { ...repo, releaseCommit: git(repo.clone, "rev-parse", "release/v0.2.0") };
  }

  test("tags the commit that set the version on origin/main and pushes the tag", async () => {
    const { clone, origin, releaseCommit } = await merged();
    const { releaseIo, printed } = io(clone, ["y"]);
    expect(await tagRelease({ root: clone, version: "0.2.0" }, releaseIo)).toBe("v0.2.0");
    expect(git(origin, "rev-parse", "v0.2.0^{commit}")).toBe(releaseCommit);
    expect(git(origin, "cat-file", "-t", "v0.2.0")).toBe("tag");
    expect(printed.join("\n")).toContain("Release notes:\n\nThe first standalone release.");
  });

  test("tags the release commit, not later work, and says what it leaves out", async () => {
    const { clone, origin, releaseCommit } = await merged();
    git(clone, "pull", "--quiet", "--ff-only", "origin", "main");
    await writeFile(path.join(clone, "later.txt"), "later");
    git(clone, "add", ".");
    git(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--message", "later work");
    git(clone, "push", "--quiet", "origin", "HEAD:main");
    const { releaseIo, printed } = io(clone);
    await tagRelease({ root: clone, version: "v0.2.0", yes: true }, releaseIo);
    expect(git(origin, "rev-parse", "v0.2.0^{commit}")).toBe(releaseCommit);
    expect(printed.join("\n")).toContain("1 commit(s) merged after the release commit; they are not part of v0.2.0");
  });

  test("refuses before the release is merged, for an existing tag, and without a terminal or --yes", async () => {
    const repo = await repository();
    await expect(tagRelease({ root: repo.clone, version: "0.2.0", yes: true }, io(repo.clone).releaseIo)).rejects.toThrow("no commit on origin/main sets version 0.2.0");
    const { clone } = await merged();
    await expect(tagRelease({ root: clone, version: "0.2.0" }, io(clone).releaseIo)).rejects.toThrow("pass --yes");
    await tagRelease({ root: clone, version: "0.2.0", yes: true }, io(clone).releaseIo);
    await expect(tagRelease({ root: clone, version: "0.2.0", yes: true }, io(clone).releaseIo)).rejects.toBeInstanceOf(ReleaseCheckError);
  });
});

test("suggests the next patch, minor and major versions", () => {
  expect(nextVersions("0.2.0")).toEqual({ patch: "0.2.1", minor: "0.3.0", major: "1.0.0" });
  expect(nextVersions("0.3.0-rc.1")).toEqual({ patch: "0.3.0", minor: "0.4.0", major: "1.0.0" });
});
