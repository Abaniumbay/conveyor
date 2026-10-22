import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { renderEventDocs } from "../../scripts/generate-event-docs";

describe("docs/events.md", () => {
  test("matches the generator output", async () => {
    const actual = await readFile(path.join(import.meta.dir, "../../docs/events.md"), "utf8");
    if (actual !== renderEventDocs()) {
      throw new Error("docs/events.md is out of date: run `bun run docs:events`");
    }
  });

  test("renders one table per group with each event's payload fields", () => {
    const text = renderEventDocs({
      "demo.changed": { group: "Demo", description: "Something changed.", payload: z.object({ id: z.string(), state: z.enum(["a", "b"]), at: z.string().nullable() }).strict() },
    });
    expect(text).toContain("### Demo");
    expect(text).toContain('| `demo.changed` | Something changed. | `id`: string<br>`state`: `"a"` \\| `"b"`<br>`at`: string \\| null |');
  });

  test("describes command correlation as scoped to its item", () => {
    const text = renderEventDocs();
    expect(text).toContain("events for its item share its correlation id");
  });
});
