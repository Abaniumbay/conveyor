#!/usr/bin/env bun
// Versioning: the version in package.json and the dated section of CHANGELOG.md move together, and
// a release is the tag v<version> on the commit that has both.
//
//   bun run scripts/release.ts prepare <version>        bump package.json, date the Unreleased changes
//   bun run scripts/release.ts check <tag> [--notes f]  verify a tag against both; write its notes
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

/** The body of the `## [version]` section, without its heading. */
export function changelogSection(changelog: string, version: string): { heading: string; body: string } | null {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^## \[/.test(line));
  return { heading: lines[start]!, body: lines.slice(start + 1, end < 0 ? undefined : end).join("\n").replace(/\n\[[^\]]+\]: .*$/gm, "").trim() };
}

/** Moves the Unreleased changes into a section for `version` dated `date`, leaving an empty Unreleased. */
export function prepareChangelog(changelog: string, version: string, date: string): string {
  const unreleased = changelogSection(changelog, "Unreleased");
  if (!unreleased || !unreleased.body) throw new ReleaseCheckError("CHANGELOG.md has no Unreleased changes to release");
  if (changelogSection(changelog, version)) throw new ReleaseCheckError(`CHANGELOG.md already has a section for ${version}`);
  return changelog.replace(unreleased.heading, `## [Unreleased]\n\n## [${version}] - ${date}`);
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

async function main(args: string[]): Promise<void> {
  const [command, value] = args;
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
    console.log(`Next: commit, open and merge the release pull request, then tag the merge commit:\n  git tag v${value} <commit> && git push origin v${value}`);
    return;
  }
  if (command === "check" && value) {
    const notes = checkRelease(value, manifest.version, changelog);
    const index = args.indexOf("--notes");
    if (index >= 0 && args[index + 1]) await writeFile(args[index + 1]!, `${notes}\n`);
    else console.log(notes);
    return;
  }
  throw new ReleaseCheckError("usage: scripts/release.ts prepare <version> | check <tag> [--notes <file>]");
}

if (import.meta.main) {
  await main(Bun.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
