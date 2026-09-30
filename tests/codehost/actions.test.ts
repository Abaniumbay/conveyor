import { describe, expect, test } from "bun:test";

import { changeAction } from "../../src/codehost/actions";

describe("change stage action aliases", () => {
  test("maps ensure names to the same operation", () => {
    expect(changeAction("change.ensure")).toBe("ensure");
    expect(changeAction("pullRequest.ensure")).toBe(changeAction("change.ensure"));
  });

  test("maps squash merge names to the same operation", () => {
    expect(changeAction("change.merge")).toBe("merge");
    expect(changeAction("pullRequest.squashMerge")).toBe(changeAction("change.merge"));
  });

  test("leaves unrelated actions available to their own handlers", () => {
    expect(changeAction("pullRequest.awaitChecks")).toBeNull();
  });
});
