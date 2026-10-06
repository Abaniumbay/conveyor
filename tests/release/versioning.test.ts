import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { changelogSection, checkRelease, isLater, prepareChangelog, ReleaseCheckError } from "../../scripts/release";

const ROOT = path.resolve(import.meta.dir, "../..");
const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- A thing.

## [0.1.0] - 2026-01-01

### Added

- The first thing.
`;

describe("versioning", () => {
  test("orders versions, with a pre-release before its release", () => {
    expect(isLater("0.2.0", "0.1.0")).toBe(true);
    expect(isLater("0.10.0", "0.9.9")).toBe(true);
    expect(isLater("0.2.0-rc.1", "0.1.0")).toBe(true);
    expect(isLater("0.2.0", "0.2.0-rc.1")).toBe(true);
    expect(isLater("0.2.0-rc.1", "0.2.0")).toBe(false);
    expect(isLater("0.1.0", "0.1.0")).toBe(false);
    expect(() => isLater("v1", "0.1.0")).toThrow(ReleaseCheckError);
  });

  test("orders pre-releases by SemVer precedence, numeric identifiers as numbers", () => {
    // The ordering example of the SemVer specification, section 11.
    const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(isLater(ordered[index]!, ordered[index - 1]!)).toBe(true);
      expect(isLater(ordered[index - 1]!, ordered[index]!)).toBe(false);
    }
    expect(isLater("1.0.0-beta.10", "1.0.0-beta.2")).toBe(true);
  });

  test("prepare moves the Unreleased changes into a dated section and leaves Unreleased empty", () => {
    const prepared = prepareChangelog(CHANGELOG, "0.2.0", "2026-10-06");
    expect(prepared).toContain("## [Unreleased]\n\n## [0.2.0] - 2026-10-06\n\n### Added\n\n- A thing.");
    expect(changelogSection(prepared, "Unreleased")?.body).toBe("");
    expect(() => prepareChangelog(prepared, "0.3.0", "2026-10-07")).toThrow("no Unreleased changes");
    expect(() => prepareChangelog(CHANGELOG, "0.1.0", "2026-10-07")).toThrow("already has a section for 0.1.0");
  });

  test("a tag must match package.json and a dated, non-empty changelog section; the section is the release notes", () => {
    const prepared = prepareChangelog(CHANGELOG, "0.2.0", "2026-10-06");
    expect(checkRelease("v0.2.0", "0.2.0", prepared)).toBe("### Added\n\n- A thing.");
    expect(() => checkRelease("0.2.0", "0.2.0", prepared)).toThrow("must be v<version>");
    expect(() => checkRelease("v0.2.1", "0.2.0", prepared)).toThrow("does not match package.json version 0.2.0");
    expect(() => checkRelease("v0.3.0", "0.3.0", prepared)).toThrow("has no section for 0.3.0");
    expect(() => checkRelease("v0.2.0", "0.2.0", prepared.replace(" - 2026-10-06", ""))).toThrow("has no release date");
  });

  test("the repository's changelog has unreleased changes ready to prepare", async () => {
    const changelog = await readFile(path.join(ROOT, "CHANGELOG.md"), "utf8");
    const manifest = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as { version: string };
    expect(changelogSection(changelog, "Unreleased")?.body).toContain("### Added");
    const prepared = prepareChangelog(changelog, "0.2.0", "2026-10-06");
    expect(checkRelease("v0.2.0", "0.2.0", prepared)).toContain("self-contained Linux executable");
    expect(isLater("0.2.0", manifest.version)).toBe(true);
  });
});
