import { describe, expect, test } from "bun:test";

import {
  conversationQuestionAnswer,
  questionConfigurationError,
  questionOptions,
  scheduledQuestionAnswerEvidence,
  validatedQuestionAnswer,
} from "../src/questions";

describe("structured questions", () => {
  test("keeps persisted string options answerable", () => {
    expect(questionOptions(["small", "large"])).toEqual([
      { id: "small", label: "small" },
      { id: "large", label: "large" },
    ]);
    expect(validatedQuestionAnswer({ options: ["small", "large"], allowFreeText: false }, "large")).toBe("large");
  });

  test("keeps options written as a label and description answerable by their label", () => {
    const question = {
      options: [
        { label: "Discuss first", description: "Open an issue before starting a pull request." },
        { label: "Defer pull requests", description: "Outside pull requests are not accepted yet." },
      ],
      allowFreeText: false,
    };
    expect(questionOptions(question.options)).toEqual([
      { id: "Discuss first", label: "Discuss first", description: "Open an issue before starting a pull request." },
      { id: "Defer pull requests", label: "Defer pull requests", description: "Outside pull requests are not accepted yet." },
    ]);
    expect(questionConfigurationError(question.options, false)).toBeNull();
    expect(validatedQuestionAnswer(question, "Defer pull requests")).toBe("Defer pull requests");
    expect(conversationQuestionAnswer(question, "discuss first")).toBe("Discuss first");
  });

  test("uses an explicit id before value and falls back to value before label", () => {
    const question = {
      options: [
        { id: " explicit-id ", value: "ignored-value", label: " Explicit choice " },
        { value: " current-main ", label: " Current main commit " },
        { label: " Label-only choice " },
      ],
      allowFreeText: false,
    };
    expect(questionOptions(question.options)).toEqual([
      { id: "explicit-id", label: "Explicit choice" },
      { id: "current-main", label: "Current main commit" },
      { id: "Label-only choice", label: "Label-only choice" },
    ]);
    expect(validatedQuestionAnswer(question, "current-main")).toBe("current-main");
    expect(validatedQuestionAnswer(question, "Current main commit")).toBe("current-main");
    expect(validatedQuestionAnswer(question, "Explicit choice")).toBe("explicit-id");
    expect(validatedQuestionAnswer(question, "Label-only choice")).toBe("Label-only choice");
  });

  test("omits empty and duplicate canonical choices and rejects ambiguous labels", () => {
    const question = {
      options: [
        { id: " ", label: "Empty identifier" },
        { value: " ", label: "Empty fallback identifier" },
        { id: "first", label: "Same label" },
        { id: "first", label: "Duplicate identifier" },
        { id: "second", label: "Same label" },
      ],
      allowFreeText: false,
    };
    expect(questionOptions(question.options)).toEqual([
      { id: "first", label: "Same label" },
      { id: "second", label: "Same label" },
    ]);
    expect(() => validatedQuestionAnswer(question, "Same label")).toThrow("Choose one of the available answers.");
    expect(() => conversationQuestionAnswer(question, "same label")).toThrow("Choose one of the available answers.");
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

  test("normalizes value-backed conversation replies to their canonical identifier", () => {
    const question = {
      options: [
        { id: "explicit", label: "Explicit choice" },
        { value: "current-main", label: "Current main commit" },
        { label: "Label-only choice" },
        "legacy string",
      ],
      allowFreeText: false,
    };
    expect(conversationQuestionAnswer(question, "current-main")).toBe("current-main");
    expect(conversationQuestionAnswer(question, "CURRENT MAIN COMMIT")).toBe("current-main");
    expect(conversationQuestionAnswer(question, "explicit choice")).toBe("explicit");
    expect(conversationQuestionAnswer(question, "label-only choice")).toBe("Label-only choice");
    expect(conversationQuestionAnswer(question, "LEGACY STRING")).toBe("legacy string");
  });

  test("requires scheduled answers to be stated by non-conflicting quoted evidence", () => {
    const question = { options: ["stable", "beta"], allowFreeText: false };

    expect(scheduledQuestionAnswerEvidence(question, "stable", "The accepted release is stable.")).toBe("stable");
    expect(() => scheduledQuestionAnswerEvidence(question, "beta", "The accepted release is stable.")).toThrow("must state the submitted answer");
    expect(() => scheduledQuestionAnswerEvidence(question, "stable", "The accepted release may be stable or beta.")).toThrow("ambiguous");
    expect(() => scheduledQuestionAnswerEvidence(question, "stable", "The accepted release is not stable.")).toThrow("must state the submitted answer");
    expect(() => scheduledQuestionAnswerEvidence(
      question,
      "stable",
      "The accepted release is stable.",
      ["The accepted release is stable.", "The acceptance criteria say the answer is beta."],
    )).toThrow("conflicts with current configured choices");
  });

  test("does not permit scheduled operators to infer free-text answers", () => {
    const question = { options: [], allowFreeText: true };

    expect(() => scheduledQuestionAnswerEvidence(question, "Ship it", "The plan says: Ship it.")).toThrow("cannot submit free-text answers");
  });
});
