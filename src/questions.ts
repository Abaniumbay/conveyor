export interface QuestionOption {
  id: string;
  label: string;
}

/** Supports the string options written by older agents while rejecting unusable data. */
export function questionOptions(options: readonly unknown[]): QuestionOption[] {
  const seen = new Set<string>();
  return options.flatMap((option) => {
    const value = typeof option === "string"
      ? { id: option, label: option }
      : option && typeof option === "object" &&
          typeof (option as { id?: unknown }).id === "string" &&
          typeof (option as { label?: unknown }).label === "string"
        ? { id: (option as { id: string }).id, label: (option as { label: string }).label }
        : null;
    if (!value || !value.id.trim() || !value.label.trim() || seen.has(value.id)) return [];
    seen.add(value.id);
    return [value];
  });
}

export function questionConfigurationError(options: readonly unknown[], allowFreeText: boolean): string | null {
  return allowFreeText || questionOptions(options).length > 0
    ? null
    : "A question needs at least one valid choice or free-text input.";
}

export function validatedQuestionAnswer(question: { options: readonly unknown[]; allowFreeText: boolean }, answer: string): string {
  const value = answer.trim();
  if (!value) throw new Error("An answer is required.");
  const configurationError = questionConfigurationError(question.options, question.allowFreeText);
  if (configurationError) throw new Error(configurationError);
  if (!question.allowFreeText && !questionOptions(question.options).some((option) => option.id === value)) {
    throw new Error("Choose one of the available answers.");
  }
  return value;
}
