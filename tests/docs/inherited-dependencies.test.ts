import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

describe("inherited dependencies documentation", () => {
  test("SPEC.md states an item is ready only when its own and every ancestor's dependencies are satisfied", async () => {
    const specification = await readFile(path.join(import.meta.dir, "../../SPEC.md"), "utf8");
    expect(specification).toContain(
      "An item is ready to start only when its own dependencies and the dependencies of every ancestor are satisfied.",
    );
  });
});
