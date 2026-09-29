import { describe, expect, test } from "bun:test";

import {
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
