import { describe, expect, test } from "bun:test";

import { isSourceAccessDenied } from "../../src/source/client";

describe("isSourceAccessDenied", () => {
  test("is true for an error the source marks as access denied", () => {
    expect(isSourceAccessDenied(Object.assign(new Error("refused"), { accessDenied: true }))).toBe(true);
  });

  test("is false for an error without the mark", () => {
    expect(isSourceAccessDenied(new Error("network unreachable"))).toBe(false);
  });

  test("is false for a value that is not an object", () => {
    expect(isSourceAccessDenied("HTTP 403")).toBe(false);
  });
});
