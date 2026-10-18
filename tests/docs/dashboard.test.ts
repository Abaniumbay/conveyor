import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.join(import.meta.dir, "../..");

describe("dashboard documentation", () => {
  test("documents the drawn Graph, its filters, and accessible relationships", async () => {
    const [dashboard, specification] = await Promise.all([
      readFile(path.join(root, "docs/dashboard.md"), "utf8"),
      readFile(path.join(root, "SPEC.md"), "utf8"),
    ]);

    expect(dashboard).toContain("server-rendered SVG");
    expect(dashboard).toContain("Repository and stage controls");
    expect(dashboard).toContain("screen-reader-only relationship list");
    expect(specification).toContain("A read-only Graph view server-renders a drawn SVG");
    expect(specification).toContain("Repository and stage filters");
    expect(specification).toContain("screen-reader relationship list");
  });

  test("ships the Graph screenshot and operator-facing release note", async () => {
    const [dashboard, screenshot, releaseNote] = await Promise.all([
      readFile(path.join(root, "docs/dashboard.md"), "utf8"),
      readFile(path.join(root, "docs/screenshots/graph.png")),
      readFile(path.join(root, "changes/332-drawn-workflow-graph.md"), "utf8"),
    ]);

    expect(dashboard).toContain("screenshots/graph.png");
    expect(screenshot.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(releaseNote).toContain("section: Changed");
    expect(releaseNote).toContain("Graph now draws workflow items");
  });
});
