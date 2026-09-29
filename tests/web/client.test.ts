import { describe, expect, test } from "bun:test";

import { dashboardClient } from "../../src/web/client";

describe("dashboard browser client", () => {
  test("is valid standalone JavaScript", () => {
    expect(() => new Function(dashboardClient)).not.toThrow();
  });
});
