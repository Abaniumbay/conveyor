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

  test("ships the Graph screenshot", async () => {
    const [dashboard, screenshot] = await Promise.all([
      readFile(path.join(root, "docs/dashboard.md"), "utf8"),
      readFile(path.join(root, "docs/screenshots/graph.png")),
    ]);

    expect(dashboard).toContain("screenshots/graph.png");
    expect(screenshot.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  test("documents the item detail stage badge and source link", async () => {
    const [dashboard, specification] = await Promise.all([
      readFile(path.join(root, "docs/dashboard.md"), "utf8"),
      readFile(path.join(root, "SPEC.md"), "utf8"),
    ]);

    expect(dashboard).toContain("stage badge");
    expect(dashboard).toContain("source issue from every tab");
    expect(specification).toContain("detail header shows a stage badge");
    expect(specification).toContain("source-issue link");
  });
});
