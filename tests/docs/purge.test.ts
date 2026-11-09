import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.join(import.meta.dir, "../..");
const read = (file: string) => readFile(path.join(root, file), "utf8");

describe("purge documentation", () => {
  test("SPEC.md describes the item lifecycle, retention and board behaviour for purged items", async () => {
    const specification = await read("SPEC.md");
    expect(specification).toContain("### Item lifecycle and purge");
    expect(specification).toContain(
      "The append-only event log keeps the item's events",
    );
    expect(specification).toContain(
      "Done items keep their labels and stay visible",
    );
    expect(specification).toContain(
      "There are no `missing` or `offboarded` projected states",
    );
  });

  test("the dashboard and events documents describe purged items", async () => {
    const [dashboard, events] = await Promise.all([
      read("docs/dashboard.md"),
      read("docs/events.md"),
    ]);
    expect(dashboard).toContain(
      "The board never shows an item that lost its Conveyor labels",
    );
    expect(events).toContain("`item.purged`");
  });
});
