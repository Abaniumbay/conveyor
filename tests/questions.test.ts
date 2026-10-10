import { describe, expect, test } from "bun:test";

import { questionConfigurationError, questionOptions, validatedQuestionAnswer } from "../src/questions";

describe("structured questions", () => {
  test("keeps persisted string options answerable", () => {
    expect(questionOptions(["small", "large"])).toEqual([
      { id: "small", label: "small" },
      { id: "large", label: "large" },
    ]);
    expect(validatedQuestionAnswer({ options: ["small", "large"], allowFreeText: false }, "large")).toBe("large");
  });

  test("rejects invalid configurations and answers that do not select a choice", () => {
    expect(questionConfigurationError([{ id: "missing-label" }], false)).toBe("A question needs at least one valid choice or free-text input.");
    expect(() => validatedQuestionAnswer({ options: ["small"], allowFreeText: false }, "large")).toThrow("Choose one of the available answers.");
    expect(() => validatedQuestionAnswer({ options: ["small"], allowFreeText: false }, " ")).toThrow("An answer is required.");
  });
});
