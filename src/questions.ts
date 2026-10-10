export interface QuestionOption {
  id: string;
  label: string;
}

/**
 * Supports the string options written by older agents and the `{ label, description }` options
 * agents write without an id (the label then identifies the choice), while rejecting unusable data.
 */
export function questionOptions(options: readonly unknown[]): QuestionOption[] {
  const seen = new Set<string>();
  return options.flatMap((option) => {
    const given = option && typeof option === "object" ? option as { id?: unknown; label?: unknown } : null;
    const value = typeof option === "string"
      ? { id: option, label: option }
      : given && typeof given.label === "string" && (typeof given.id === "string" || given.id == null)
        ? { id: typeof given.id === "string" ? given.id : given.label, label: given.label }
        : null;
    const id = value?.id.trim();
    const label = value?.label.trim();
    if (!id || !label || seen.has(id)) return [];
    seen.add(id);
    return [{ id, label }];
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

/**
 * Conversation replies are human-facing, so accept a rendered choice label as
 * well as its stored identifier and persist the canonical identifier.
 */
export function conversationQuestionAnswer(question: { options: readonly unknown[]; allowFreeText: boolean }, answer: string): string {
  const value = answer.trim();
  if (!value) throw new Error("An answer is required.");
  const configurationError = questionConfigurationError(question.options, question.allowFreeText);
  if (configurationError) throw new Error(configurationError);
  if (question.allowFreeText) return value;
  const normalized = value.toLocaleLowerCase();
  const choice = questionOptions(question.options).find((option) =>
    option.id === value || option.label.toLocaleLowerCase() === normalized,
  );
  if (!choice) throw new Error("Choose one of the available answers.");
  return choice.id;
}
