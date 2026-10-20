import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.join(import.meta.dir, "../..");

const architecture = async () => readFile(path.join(root, "docs/architecture.md"), "utf8");

describe("architecture documentation", () => {
  test("requires each acceptance criterion to state one condition with one expected outcome", async () => {
    expect(await architecture()).toContain("each criterion states one condition with one expected outcome");
  });

  test("requires each distinct requirement case to have its own criterion", async () => {
    expect(await architecture()).toContain("Give each distinct case in a requirement its own criterion");
  });

  test("requires proof-relevant real boundaries to be named", async () => {
    expect(await architecture()).toContain("When a criterion's proof depends on a real boundary, name that boundary");
  });

  test("targets about six one-behavior criteria for an ordinary implementation item", async () => {
    expect(await architecture()).toContain("An ordinary implementation item should target about six one-behavior criteria");
  });

  test("requires splitting above eight criteria unless the behaviors cannot ship separately", async () => {
    expect(await architecture()).toContain("Split an item that needs more than eight criteria unless its behaviors cannot ship separately");
  });
});
