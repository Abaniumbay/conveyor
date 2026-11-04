import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.join(import.meta.dir, "../..");

describe("webhook delivery retention documentation", () => {
  test("documents settings.retention.webhookDeliveries, its 7d default and the 24h minimum", async () => {
    const configuration = await readFile(path.join(root, "docs/configuration.md"), "utf8");
    expect(configuration).toContain("webhookDeliveries");
    expect(configuration).toMatch(/default\s+`7d`/);
    expect(configuration).toMatch(/shorter than 24 hours/);
  });
});
