import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { labelNames, publicSurface, renderPublicSurface } from "../../scripts/generate-public-surface";

describe("docs/public-surface.txt", () => {
  test("matches the generator output", async () => {
    const actual = await readFile(path.join(import.meta.dir, "../../docs/public-surface.txt"), "utf8");
    if (actual !== renderPublicSurface()) throw new Error("docs/public-surface.txt is out of date: run `bun run docs:surface`");
  });

  test("lists every kind of public name Conveyor has", () => {
    const surface = publicSurface();
    for (const line of [
      "cli conveyor item retry",
      "cli-option --home",
      "event item.offboarded",
      "event-field item.offboarded status",
      "task ci.start",
      "task-input agent.askQuestion prompt",
      "config settings.retention",
      "config repositories.<name>.address",
      "config stages[].exit-gate[].task",
      "builtin stages.yaml",
      "label conveyor:done",
      "label conveyor:{stage}",
    ]) expect(surface).toContain(line);
  });

  test("reads label names from a provider definition", () => {
    expect(labelNames("items:\n  github:\n    labels:\n      enrollment: conveyor\n      states: { done: conveyor:done }\n")).toEqual(["conveyor", "conveyor:done"]);
  });
});
