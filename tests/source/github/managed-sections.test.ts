import { describe, expect, test } from "bun:test";

import {
  renderAcceptanceCriteriaSection,
  renderRefinementSection,
  formatAcceptanceCriteria,
  formatDependencies,
  ManagedSectionError,
  parseManagedSections,
  upsertManagedSection,
} from "../../../src/source/github/managed-sections";

describe("managed GitHub issue body sections", () => {
  test("parses managed sections and hashes the complete source body", () => {
    const body = [
      "Human introduction",
      "<!-- conveyor:acceptance-criteria:start -->",
      "- [ ] Save changes <!-- conveyor:criterion:AC-1 -->",
      "<!-- conveyor:acceptance-criteria:end -->",
      "Human footer",
    ].join("\n");

    const parsed = parseManagedSections(body);

    expect(parsed.sections["acceptance-criteria"]).toBe(
      "- [ ] Save changes <!-- conveyor:criterion:AC-1 -->",
    );
    expect(parsed.sections.dependencies).toBeUndefined();
    expect(parsed.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  test("updates only the managed content, preserving surrounding prose", () => {
    const before = [
      "Keep this paragraph exactly.",
      "<!-- conveyor:dependencies:start -->",
      "- #2",
      "<!-- conveyor:dependencies:end -->",
      "Keep this footer too.",
    ].join("\n");
    const updated = upsertManagedSection(
      before,
      "dependencies",
      "- #8",
      parseManagedSections(before).revision,
    );

    expect(updated).toBe(
      [
        "Keep this paragraph exactly.",
        "<!-- conveyor:dependencies:start -->",
        "- #8",
        "<!-- conveyor:dependencies:end -->",
        "Keep this footer too.",
      ].join("\n"),
    );
  });

  test("appends a new managed section without rewriting existing body", () => {
    const body = "Human text\n";
    const result = upsertManagedSection(
      body,
      "acceptance-criteria",
      "- [ ] Works <!-- conveyor:criterion:AC-1 -->",
      parseManagedSections(body).revision,
    );

    expect(result).toBe(
      "Human text\n\n<!-- conveyor:acceptance-criteria:start -->\n" +
        "- [ ] Works <!-- conveyor:criterion:AC-1 -->\n" +
        "<!-- conveyor:acceptance-criteria:end -->\n",
    );
  });

  test("rejects stale revisions before changing the body", () => {
    expect(() =>
      upsertManagedSection("Changed by a person", "dependencies", "- #2", "0".repeat(64)),
    ).toThrow(ManagedSectionError);
  });

  test("preserves CRLF boundaries and rejects content that injects managed markers", () => {
    const body = "Before\r\n<!-- conveyor:dependencies:start -->\r\n- #2\r\n<!-- conveyor:dependencies:end -->\r\nAfter";
    const updated = upsertManagedSection(
      body,
      "dependencies",
      "- #3",
      parseManagedSections(body).revision,
    );

    expect(updated).toBe("Before\r\n<!-- conveyor:dependencies:start -->\r\n- #3\r\n<!-- conveyor:dependencies:end -->\r\nAfter");
    expect(() =>
      upsertManagedSection(
        body,
        "dependencies",
        "<!-- conveyor:acceptance-criteria:start -->",
        parseManagedSections(body).revision,
      ),
    ).toThrow(ManagedSectionError);
  });

  test("rejects missing, duplicate, reversed, or malformed markers", () => {
    const invalidBodies = [
      "<!-- conveyor:acceptance-criteria:start -->\ntext",
      "<!-- conveyor:dependencies:start -->\n<!-- conveyor:dependencies:start -->\n<!-- conveyor:dependencies:end -->",
      "<!-- conveyor:dependencies:end -->\n<!-- conveyor:dependencies:start -->",
      "<!-- conveyor:dependencies:begin -->",
    ];

    for (const body of invalidBodies) {
      expect(() => parseManagedSections(body)).toThrow(ManagedSectionError);
    }
  });

  test("formats stable criterion IDs and ordered issue dependencies", () => {
    expect(
      formatAcceptanceCriteria([
        { id: "AC-2", text: "Second", completed: true },
        { id: "AC-1", text: "First" },
      ]),
    ).toBe(
      "- [x] Second <!-- conveyor:criterion:AC-2 -->\n" +
        "- [ ] First <!-- conveyor:criterion:AC-1 -->",
    );
    expect(
      formatDependencies([
        { number: 12 },
        { number: 7, repository: "owner/repo" },
      ]),
    ).toBe("- #12\n- owner/repo#7");
  });
});

describe("refinement section and legacy criteria", () => {
  const write = (body: string, name: Parameters<typeof upsertManagedSection>[1], markdown: string) =>
    upsertManagedSection(body, name, markdown, parseManagedSections(body).revision);
  const refinement = renderRefinementSection({
    summary: "One release.", inScope: ["Tools"], outOfScope: [], areas: ["src/a.ts"], coupling: [], risks: ["Risk"], verification: ["Tests"],
  });

  test("the refinement section has a heading, omits empty parts, and rewriting replaces only that section", () => {
    expect(refinement).toBe("## Refinement\n\nOne release.\n\n**In scope**\n- Tools\n\n**Areas and files expected to change**\n- src/a.ts\n\n**Main risks**\n- Risk\n\n**Verification**\n- Tests");
    const body = [
      "Intro", "<!-- conveyor:acceptance-criteria:start -->", "- [ ] A <!-- conveyor:criterion:a -->", "<!-- conveyor:acceptance-criteria:end -->",
      "<!-- conveyor:dependencies:start -->", "- #1", "<!-- conveyor:dependencies:end -->", "Footer", "",
    ].join("\n");
    const first = write(body, "refinement", refinement);
    expect(parseManagedSections(first).sections.refinement).toBe(refinement);
    const second = write(first, "refinement", "## Refinement\n\nChanged.");
    expect(parseManagedSections(second).sections.refinement).toBe("## Refinement\n\nChanged.");
    expect(second.replace("Changed.", "One release.")).not.toBe(first);
    const { refinement: _gone, ...others } = parseManagedSections(second).sections;
    expect(others).toEqual({ "acceptance-criteria": "- [ ] A <!-- conveyor:criterion:a -->", dependencies: "- #1" });
    expect(second.startsWith("Intro\n<!-- conveyor:acceptance-criteria:start -->")).toBe(true);
    expect(second.endsWith("Footer\n\n<!-- conveyor:refinement:start -->\n## Refinement\n\nChanged.\n<!-- conveyor:refinement:end -->\n")).toBe(true);
  });

  test("rejects a stale body revision", () => {
    expect(() => upsertManagedSection("Body", "refinement", refinement, parseManagedSections("Other").revision)).toThrow("stale");
  });

  test("refuses a summary that is empty or carries a managed marker", () => {
    const base = { inScope: [], outOfScope: [], areas: [], coupling: [], risks: [], verification: [] };
    expect(() => renderRefinementSection({ ...base, summary: " " })).toThrow(ManagedSectionError);
    expect(() => renderRefinementSection({ ...base, summary: "<!-- conveyor:refinement:end -->" })).toThrow(ManagedSectionError);
  });

  const section = renderAcceptanceCriteriaSection([{ id: "AC-1", text: "New" }]);

  test("the managed criteria render under an Acceptance Criteria heading", () => {
    expect(section).toBe("## Acceptance Criteria\n\n- [ ] New <!-- conveyor:criterion:AC-1 -->");
  });

  test("an unmanaged Acceptance Criteria checklist is replaced in place, leaving other text alone", () => {
    const body = "Intro\n\n## Acceptance Criteria\n\n- [ ] old one\n- [x] old two\n\n## Notes\nKeep me.\n";
    const updated = write(body, "acceptance-criteria", section);
    expect(updated).toBe(`Intro\n\n<!-- conveyor:acceptance-criteria:start -->\n${section}\n<!-- conveyor:acceptance-criteria:end -->\n\n## Notes\nKeep me.\n`);
    expect(updated).not.toContain("old one");
    expect(updated.match(/^## Acceptance Criteria$/gm)).toHaveLength(1);
  });

  test("an unmanaged checklist beside an existing managed section is removed, and repeated writes stay single-list", () => {
    const body = [
      "Intro", "", "## Acceptance Criteria", "", "- [ ] hand written", "", "<!-- conveyor:acceptance-criteria:start -->",
      "- [ ] managed <!-- conveyor:criterion:m -->", "<!-- conveyor:acceptance-criteria:end -->", "", "<!-- conveyor:dependencies:start -->", "- #3",
      "<!-- conveyor:dependencies:end -->", "", "Outro", "",
    ].join("\n");
    const once = write(body, "acceptance-criteria", section);
    expect(once).not.toContain("hand written");
    expect(once).toContain("Intro\n\n<!-- conveyor:acceptance-criteria:start -->");
    expect(once).toContain("<!-- conveyor:dependencies:start -->\n- #3\n<!-- conveyor:dependencies:end -->\n\nOutro\n");
    expect(once.match(/- \[[ x]\]/g)).toHaveLength(1);
    expect(write(once, "acceptance-criteria", section)).toBe(once);
  });

  test("a heading without a checklist, or a checklist under another heading, is untouched", () => {
    const body = "## Acceptance Criteria\n\nSee the design.\n\n## Tasks\n- [ ] not criteria\n";
    const updated = write(body, "acceptance-criteria", section);
    expect(updated.startsWith(body)).toBe(true);
    expect(updated).toContain("- [ ] not criteria");
  });
});
