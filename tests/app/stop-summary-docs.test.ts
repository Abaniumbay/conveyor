import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("stop-summary instructions and documentation", () => {
  test("operator instructions state the summary rule and include the four examples", async () => {
    const text = await readFile("examples/config/instructions/omid.md", "utf8");
    expect(text).toContain("one or two short sentences in plain language");
    expect(text).toContain("log excerpts, stack traces or links");
    expect(text).toContain("speculate");
    expect(text).toContain("runs the string with $SHELL -c");
    expect(text).toContain("exits with 127");
    expect(text).toContain("stopped without pushing a commit");
    expect(text).toContain("which database should the import use?");
  });

  test("SPEC.md and the Operator documentation describe the stop-summary run", async () => {
    const spec = await readFile("SPEC.md", "utf8");
    expect(spec).toContain("**Stop-summary run.**");
    const docs = await readFile("docs/operator-mcp.md", "utf8");
    expect(docs).toContain("## Stop summary");
  });
});
