#!/usr/bin/env bun
// Cutting a release. The version in package.json and the dated section of CHANGELOG.md move
// together, and a release is the tag v<version> on the commit that has both; pushing the tag runs
// .github/workflows/release.yml, which tests, builds and publishes it.
//
//   bun run release start [<version>] [--summary <text> | --summary-file <file|->] [--yes]
//       On an up-to-date main: asks for the version and a release summary, prepares package.json
//       and CHANGELOG.md, and opens the release pull request.
//   bun run release tag <version> [--yes] [--watch]
//       After that pull request merged: tags the commit that set the version and pushes the tag.
//   bun run release prepare <version>          only bump package.json and date the changelog
//   bun run release check <tag> [--notes <f>]  verify a tag against both; print or write its notes
//
// See docs/releasing.md.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export class ReleaseCheckError extends Error {}

function parse(version: string): [number, number, number, string | null] {
  const match = SEMVER.exec(version);
  if (!match) throw new ReleaseCheckError(`${version} is not a semantic version (X.Y.Z or X.Y.Z-pre)`);
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? null];
}

/** True when `next` is a later version than `current` (a pre-release sorts before its release). */
export function isLater(next: string, current: string): boolean {
  const [a, b] = [parse(next), parse(current)];
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return (a[index] as number) > (b[index] as number);
  if (a[3] === b[3]) return false;
  if (a[3] === null) return true;
  if (b[3] === null) return false;
  return a[3] > b[3];
}

/** The usual next versions after `current`. */
export function nextVersions(current: string): { patch: string; minor: string; major: string } {
  const [major, minor, patch, pre] = parse(current);
  return {
    patch: pre ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`,
    minor: `${major}.${minor + 1}.0`,
    major: `${major + 1}.0.0`,
  };
}

/** The body of the `## [version]` section, without its heading. */
export function changelogSection(changelog: string, version: string): { heading: string; body: string } | null {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^## \[/.test(line));
  return { heading: lines[start]!, body: lines.slice(start + 1, end < 0 ? undefined : end).join("\n").replace(/\n\[[^\]]+\]: .*$/gm, "").trim() };
}

/**
 * Moves the Unreleased changes into a section for `version` dated `date`, leaving an empty
 * Unreleased. A `summary` becomes the section's first paragraph: the opening of the release notes.
 */
export function prepareChangelog(changelog: string, version: string, date: string, summary?: string): string {
  const unreleased = changelogSection(changelog, "Unreleased");
  if (!unreleased || !unreleased.body) throw new ReleaseCheckError("CHANGELOG.md has no Unreleased changes to release");
  if (changelogSection(changelog, version)) throw new ReleaseCheckError(`CHANGELOG.md already has a section for ${version}`);
  const opening = summary?.trim() ? `\n\n${summary.trim()}` : "";
  return changelog.replace(unreleased.heading, `## [Unreleased]\n\n## [${version}] - ${date}${opening}`);
}

/** Verifies `tag` (vX.Y.Z) against package.json and CHANGELOG.md and returns the release notes. */
export function checkRelease(tag: string, packageVersion: string, changelog: string): string {
  if (!tag.startsWith("v")) throw new ReleaseCheckError(`tag ${tag} must be v<version>`);
  const version = tag.slice(1);
  parse(version);
  if (version !== packageVersion) throw new ReleaseCheckError(`tag ${tag} does not match package.json version ${packageVersion}`);
  const section = changelogSection(changelog, version);
  if (!section) throw new ReleaseCheckError(`CHANGELOG.md has no section for ${version}: run scripts/release.ts prepare ${version}`);
  if (!/ - \d{4}-\d{2}-\d{2}$/.test(section.heading)) throw new ReleaseCheckError(`the CHANGELOG.md section for ${version} has no release date`);
  if (!section.body) throw new ReleaseCheckError(`the CHANGELOG.md section for ${version} is empty`);
  return section.body;
}

/** Everything the guided commands do outside their own logic, so tests can drive them. */
export interface ReleaseIo {
  /** Runs a command in the repository; `stdin` is passed to it. */
  run(argv: string[], options?: { stdin?: string }): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Asks one question on the terminal; null when there is no terminal. */
  ask(question: string): Promise<string | null>;
  /** Asks for text until an empty line; null when there is no terminal. */
  askText(question: string): Promise<string | null>;
  print(text: string): void;
  today(): string;
}

async function must(io: ReleaseIo, argv: string[], what: string, stdin?: string): Promise<string> {
  const result = await io.run(argv, stdin === undefined ? {} : { stdin });
  if (result.code !== 0) throw new ReleaseCheckError(`${what} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
  return result.stdout.trim();
}

/** Refuses unless the checkout is clean, on main, and level with origin/main, and gh is signed in. */
async function requireCleanMain(io: ReleaseIo): Promise<void> {
  if ((await io.run(["gh", "auth", "status"])).code !== 0) throw new ReleaseCheckError("the GitHub CLI is not signed in: run gh auth login");
  if (await must(io, ["git", "status", "--porcelain"], "git status")) throw new ReleaseCheckError("the working tree has uncommitted changes: commit or stash them first");
  const branch = await must(io, ["git", "rev-parse", "--abbrev-ref", "HEAD"], "git rev-parse");
  if (branch !== "main") throw new ReleaseCheckError(`releases start from main, not ${branch}: git switch main`);
  await must(io, ["git", "fetch", "--quiet", "origin", "main", "--tags"], "git fetch");
  const [local, remote] = [await must(io, ["git", "rev-parse", "HEAD"], "git rev-parse"), await must(io, ["git", "rev-parse", "origin/main"], "git rev-parse")];
  if (local !== remote) throw new ReleaseCheckError("main is not level with origin/main: git pull --ff-only (and push anything local first)");
}

async function confirm(io: ReleaseIo, question: string, yes: boolean): Promise<void> {
  if (yes) return;
  const answer = await io.ask(`${question} [y/N] `);
  if (answer === null) throw new ReleaseCheckError("not a terminal: pass --yes to go ahead without confirming");
  if (!/^y(es)?$/i.test(answer.trim())) throw new ReleaseCheckError("stopped; nothing was changed");
}

export interface StartOptions {
  root: string;
  version?: string;
  /** The release summary; asked for when absent. */
  summary?: string;
  yes?: boolean;
}

/** Prepares the release on a new branch and opens its pull request; returns the pull request URL. */
export async function startRelease(options: StartOptions, io: ReleaseIo): Promise<string> {
  await requireCleanMain(io);
  const packageFile = path.join(options.root, "package.json");
  const changelogFile = path.join(options.root, "CHANGELOG.md");
  const manifestText = await readFile(packageFile, "utf8");
  const current = (JSON.parse(manifestText) as { version: string }).version;
  const changelog = await readFile(changelogFile, "utf8");
  const unreleased = changelogSection(changelog, "Unreleased");
  if (!unreleased?.body) throw new ReleaseCheckError("CHANGELOG.md has no Unreleased changes to release: add them first");

  let version = options.version;
  if (!version) {
    const next = nextVersions(current);
    const answer = await io.ask(`Version to release (current ${current}; patch ${next.patch}, minor ${next.minor}, major ${next.major}): `);
    if (answer === null) throw new ReleaseCheckError("not a terminal: pass the version, e.g. bun run release start 0.2.0");
    version = answer.trim().replace(/^v/, "");
  }
  if (!isLater(version, current)) throw new ReleaseCheckError(`${version} is not later than the current version ${current}`);
  const tag = `v${version}`;
  if ((await io.run(["git", "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`])).code === 0) throw new ReleaseCheckError(`tag ${tag} already exists`);
  const branch = `release/${tag}`;
  if ((await io.run(["git", "ls-remote", "--exit-code", "--heads", "origin", branch])).code === 0) throw new ReleaseCheckError(`branch ${branch} already exists on origin: is a release pull request already open?`);

  io.print(`\nChanges in ${tag} (the Unreleased section of CHANGELOG.md):\n\n${unreleased.body}\n`);
  let summary = options.summary?.trim();
  if (!summary) {
    const answer = await io.askText("Release summary: a few sentences on what this release is about, shown first in the release notes. End with an empty line:\n");
    if (answer === null) throw new ReleaseCheckError("not a terminal: pass --summary <text> or --summary-file <file>");
    summary = answer.trim();
  }
  if (!summary) throw new ReleaseCheckError("the release summary is required");

  const prepared = prepareChangelog(changelog, version, io.today(), summary);
  const notes = checkRelease(tag, version, prepared);
  io.print(`\nRelease notes for ${tag}:\n\n${notes}\n`);
  await confirm(io, `Open the release pull request for ${tag}?`, options.yes === true);

  await must(io, ["git", "switch", "--create", branch], "git switch");
  await writeFile(changelogFile, prepared);
  await writeFile(packageFile, manifestText.replace(`"version": "${current}"`, `"version": "${version}"`));
  await must(io, ["git", "add", "package.json", "CHANGELOG.md"], "git add");
  await must(io, ["git", "commit", "--quiet", "--message", `chore(release): ${tag}`], "git commit");
  await must(io, ["git", "push", "--quiet", "--set-upstream", "origin", branch], "git push");
  const body = [
    `Prepares ${tag}: \`package.json\` version ${version} and the dated CHANGELOG section below.`,
    "",
    `After this merges, tag it: \`bun run release tag ${version}\`. The tag runs the Release workflow, which tests, builds and publishes ${tag}.`,
    "",
    "## Release notes",
    "",
    notes,
  ].join("\n");
  const url = await must(io, ["gh", "pr", "create", "--base", "main", "--head", branch, "--title", `Release ${tag}`, "--body-file", "-"], "gh pr create", body);
  io.print(`Opened ${url}\nWhen it has merged: bun run release tag ${version}`);
  return url;
}

export interface TagOptions {
  root: string;
  version: string;
  yes?: boolean;
  watch?: boolean;
}

/** Tags the commit on origin/main that set the version, after checking it, and pushes the tag. */
export async function tagRelease(options: TagOptions, io: ReleaseIo): Promise<string> {
  const version = options.version.replace(/^v/, "");
  const tag = `v${version}`;
  parse(version);
  await must(io, ["git", "fetch", "--quiet", "origin", "main", "--tags"], "git fetch");
  if ((await io.run(["git", "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`])).code === 0) throw new ReleaseCheckError(`tag ${tag} already exists`);
  // The release commit is the one on main that set this version in package.json.
  const commit = await must(io, ["git", "log", "-1", "--format=%H", `-S"version": "${version}"`, "origin/main", "--", "package.json"], "git log");
  if (!commit) throw new ReleaseCheckError(`no commit on origin/main sets version ${version}: merge the release pull request first (bun run release start ${version})`);
  const manifest = JSON.parse(await must(io, ["git", "show", `${commit}:package.json`], "git show")) as { version: string };
  const notes = checkRelease(tag, manifest.version, await must(io, ["git", "show", `${commit}:CHANGELOG.md`], "git show"));
  const later = await must(io, ["git", "rev-list", "--count", `${commit}..origin/main`], "git rev-list");
  io.print(`\n${tag} -> ${commit.slice(0, 12)} (${await must(io, ["git", "log", "-1", "--format=%s", commit], "git log")})\n\nRelease notes:\n\n${notes}\n`);
  if (later !== "0") io.print(`Note: ${later} commit(s) merged after the release commit; they are not part of ${tag}.\n`);
  await confirm(io, `Push tag ${tag}? This publishes the release.`, options.yes === true);
  await must(io, ["git", "tag", "--annotate", tag, "--message", `Conveyor ${tag}`, commit], "git tag");
  await must(io, ["git", "push", "--quiet", "origin", `refs/tags/${tag}`], "git push");
  io.print(`Pushed ${tag}. The Release workflow is publishing it: gh run list --workflow release.yml`);
  if (options.watch) {
    // Give GitHub a moment to start the run the tag triggered.
    await Bun.sleep(10_000);
    const run = await must(io, ["gh", "run", "list", "--workflow", "release.yml", "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId"], "gh run list");
    if (run) await must(io, ["gh", "run", "watch", run, "--exit-status"], "the Release workflow");
    io.print(`Published: gh release view ${tag}`);
  }
  return tag;
}

/** One reader for every question, so answers are read in order from the same stdin. */
let stdinLines: AsyncIterator<string> | null = null;
async function readAnswer(): Promise<string | null> {
  stdinLines ??= console[Symbol.asyncIterator]();
  const next = await stdinLines.next();
  return next.done ? null : next.value;
}

/** The terminal and the repository's git and gh. */
function processIo(root: string): ReleaseIo {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    async run(argv, options = {}) {
      const child = Bun.spawn(argv, { cwd: root, stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin), stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (argv[0] === "gh" && argv[1] === "run" && argv[2] === "watch") process.stdout.write(stdout);
      return { code, stdout, stderr };
    },
    async ask(question) {
      if (!interactive) return null;
      process.stdout.write(question);
      return (await readAnswer()) ?? "";
    },
    async askText(question) {
      if (!interactive) return null;
      process.stdout.write(question);
      const lines: string[] = [];
      for (let line = await readAnswer(); line !== null && line.trim() !== ""; line = await readAnswer()) lines.push(line);
      return lines.join("\n");
    },
    print: (text) => console.log(text),
    today: () => new Date().toISOString().slice(0, 10),
  };
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(args: string[]): Promise<void> {
  const [command, value] = args;
  const io = processIo(ROOT);
  if (command === "start") {
    const summaryFile = option(args, "--summary-file");
    const summary = option(args, "--summary") ?? (summaryFile ? (summaryFile === "-" ? await Bun.stdin.text() : await readFile(summaryFile, "utf8")) : undefined);
    const version = value && !value.startsWith("--") ? value.replace(/^v/, "") : undefined;
    await startRelease({ root: ROOT, ...(version ? { version } : {}), ...(summary ? { summary } : {}), yes: args.includes("--yes") }, io);
    return;
  }
  if (command === "tag" && value) {
    await tagRelease({ root: ROOT, version: value, yes: args.includes("--yes"), watch: args.includes("--watch") }, io);
    return;
  }
  const packageFile = path.join(ROOT, "package.json");
  const changelogFile = path.join(ROOT, "CHANGELOG.md");
  const manifest = JSON.parse(await readFile(packageFile, "utf8")) as { version: string };
  const changelog = await readFile(changelogFile, "utf8");
  if (command === "prepare" && value) {
    if (!isLater(value, manifest.version)) throw new ReleaseCheckError(`${value} is not later than the current version ${manifest.version}`);
    const date = new Date().toISOString().slice(0, 10);
    await writeFile(changelogFile, prepareChangelog(changelog, value, date));
    await writeFile(packageFile, (await readFile(packageFile, "utf8")).replace(`"version": "${manifest.version}"`, `"version": "${value}"`));
    console.log(`Prepared ${value} (${date}): package.json and CHANGELOG.md updated.`);
    return;
  }
  if (command === "check" && value) {
    const notes = checkRelease(value, manifest.version, changelog);
    const notesFile = option(args, "--notes");
    if (notesFile) await writeFile(notesFile, `${notes}\n`);
    else console.log(notes);
    return;
  }
  throw new ReleaseCheckError([
    "usage: bun run release <command>",
    "  start [<version>] [--summary <text> | --summary-file <file|->] [--yes]   prepare the release and open its pull request",
    "  tag <version> [--yes] [--watch]                                          tag the merged release and publish it",
    "  prepare <version>                                                        only bump package.json and date the changelog",
    "  check <tag> [--notes <file>]                                             verify a tag and print or write its notes",
  ].join("\n"));
}

if (import.meta.main) {
  await main(Bun.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
