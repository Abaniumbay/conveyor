import { describe, expect, test } from "bun:test";

import { dashboardClient } from "../../src/web/client";

describe("dashboard browser client", () => {
  test("is valid standalone JavaScript", () => {
    expect(() => new Function(dashboardClient)).not.toThrow();
    expect(dashboardClient).toContain("activityUrl");
    expect(dashboardClient).toContain("data-detail-tab");
    expect(dashboardClient).toContain("field.value = ''");
    expect(dashboardClient).toContain("field.value = submittedMessage");
  });
});
