import { describe, expect, test } from "bun:test";

import { conversationQuestionAnswer, questionConfigurationError, questionOptions, validatedQuestionAnswer } from "../src/questions";

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

  test("normalizes stored choice identifiers and accepts a conversation reply by label", () => {
    const question = { options: [{ id: " yes ", label: " Yes, proceed " }], allowFreeText: false };
    expect(questionOptions(question.options)).toEqual([{ id: "yes", label: "Yes, proceed" }]);
    expect(validatedQuestionAnswer(question, " yes ")).toBe("yes");
    expect(conversationQuestionAnswer(question, "yes, PROCEED")).toBe("yes");
    expect(() => conversationQuestionAnswer(question, "a sentence that is not a choice")).toThrow("Choose one of the available answers.");
  });
});
