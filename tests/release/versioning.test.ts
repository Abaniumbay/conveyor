import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { changelogSection, checkRelease, isLater, prepareChangelog, ReleaseCheckError } from "../../scripts/release";
import { readChangelogFragments, renderReleaseNotes, renderUnreleased } from "../../scripts/changelog-fragments";

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- A thing.

## [0.1.0] - 2026-01-01

### Added

- The first thing.
`;

describe("versioning", () => {
  test("renders fragments by section, issue number, and filename without changing their files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-changelog-fragments-"));
    try {
      const changes = path.join(root, "changes");
      await mkdir(changes);
      await writeFile(path.join(changes, "20-z.md"), "---\nsection: Fixed\n---\nLater fix.\nWith detail.\n");
      await writeFile(path.join(changes, "3-b.md"), "---\nsection: Added\n---\nSecond addition.\n");
      await writeFile(path.join(changes, "3-a.md"), "---\nsection: Added\nbreaking: true\n---\nFirst addition.\n");

      const fragments = await readChangelogFragments(root);
      expect(renderUnreleased(fragments)).toBe("## [Unreleased]\n\n### Added\n\n- **Breaking:** First addition.\n\n- Second addition.\n\n### Fixed\n\n- Later fix.\n  With detail.");
      expect(renderReleaseNotes(fragments)).toBe("### Added\n\n- **Breaking:** First addition.\n\n- Second addition.\n\n### Fixed\n\n- Later fix.\n  With detail.");
      expect(await readFile(path.join(changes, "3-a.md"), "utf8")).toContain("breaking: true");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects each invalid fragment contract independently", async () => {
    const cases = [
      ["1-missing-section.md", "---\n---\nEntry.", "missing section"],
      ["2-unknown-section.md", "---\nsection: Other\n---\nEntry.", "unknown section"],
      ["3-unknown-key.md", "---\nsection: Added\nextra: true\n---\nEntry.", "unknown frontmatter key"],
      ["4-empty-body.md", "---\nsection: Added\n---\n   \n", "body must not be empty"],
      ["0-no-issue.md", "---\nsection: Added\n---\nEntry.", "filename must start with a positive issue number and hyphen"],
      ["5-invalid-breaking.md", "---\nsection: Added\nbreaking: false\n---\nEntry.", "breaking must be true when present"],
      ["6-leading-content.md", "Preamble.\n---\nsection: Added\n---\nEntry.", "must start with --- frontmatter"],
    ] as const;
    for (const [name, content, message] of cases) {
      const root = await mkdtemp(path.join(tmpdir(), "conveyor-changelog-invalid-"));
      try {
        await mkdir(path.join(root, "changes"));
        await writeFile(path.join(root, "changes", name), content);
        await expect(readChangelogFragments(root)).rejects.toThrow(message);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("the changelog preview reads temporary repository fragments without changing files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-changelog-preview-"));
    try {
      const changes = path.join(root, "changes");
      const changelog = path.join(root, "CHANGELOG.md");
      await mkdir(changes);
      await writeFile(changelog, CHANGELOG);
      await writeFile(path.join(changes, "7-preview.md"), "---\nsection: Fixed\n---\nPreview a fix.\n");

      const before = await Promise.all([readFile(changelog, "utf8"), readFile(path.join(changes, "7-preview.md"), "utf8")]);
      expect(renderUnreleased(await readChangelogFragments(root))).toBe("## [Unreleased]\n\n### Fixed\n\n- Preview a fix.");
      await expect(Promise.all([readFile(changelog, "utf8"), readFile(path.join(changes, "7-preview.md"), "utf8")])).resolves.toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

});
