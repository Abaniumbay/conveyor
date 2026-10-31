export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

/**
 * Supports string options written by older agents. Structured options use `id` when present, then
 * the legacy `value` field, and finally their label as the stable answer identifier.
 */
export function questionOptions(options: readonly unknown[]): QuestionOption[] {
  const seen = new Set<string>();
  return options.flatMap((option) => {
    const given = option && typeof option === "object" ? option as { id?: unknown; value?: unknown; label?: unknown; description?: unknown } : null;
    const value = typeof option === "string"
      ? { id: option, label: option }
      : given && typeof given.label === "string" && (typeof given.id === "string" || given.id == null)
        ? {
            id: typeof given.id === "string"
              ? given.id
              : typeof given.value === "string"
                ? given.value
                : given.label,
            label: given.label,
          }
        : null;
    const id = value?.id.trim();
    const label = value?.label.trim();
    if (!id || !label || seen.has(id)) return [];
    seen.add(id);
    return [{ id, label, ...(typeof given?.description === "string" ? { description: given.description } : {}) }];
  });
}

/** Normalizes new structured choices before they are stored, while preserving legacy strings. */
export function normalizedQuestionOptions(options: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  return options.flatMap<unknown>((option) => {
    const normalized = questionOptions([option])[0];
    if (!normalized || seen.has(normalized.id)) return [];
    seen.add(normalized.id);
    if (typeof option === "string") return [option];
    const description = (option as { description?: unknown }).description;
    return [{
      id: normalized.id,
      label: normalized.label,
      ...(typeof description === "string" ? { description } : {}),
    }];
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
  if (question.allowFreeText) return value;
  const choice = selectedQuestionOption(questionOptions(question.options), value, false);
  if (!choice) throw new Error("Choose one of the available answers.");
  return choice.id;
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
  const choice = selectedQuestionOption(questionOptions(question.options), value, true);
  if (!choice) throw new Error("Choose one of the available answers.");
  return choice.id;
}

/**
 * Confirms that an autonomous answer is the only configured choice stated by
 * the quoted source evidence. Free-text answers need an owner to supply the
 * missing intent, so a scheduled operator may not infer them.
 */
export function scheduledQuestionAnswerEvidence(
  question: { options: readonly unknown[]; allowFreeText: boolean },
  answer: string,
  evidence: string,
  currentEvidence: readonly string[] = [evidence],
): string {
  const response = validatedQuestionAnswer(question, answer);
  if (question.allowFreeText) throw new Error("Scheduled Operators cannot submit free-text answers.");

  const stated = questionOptions(question.options).filter((option) =>
    quotedChoice(evidence, option.id) || quotedChoice(evidence, option.label),
  );
  if (!stated.some((option) => option.id === response)) {
    throw new Error("Scheduled answer evidence must state the submitted answer.");
  }
  if (stated.some((option) => option.id !== response)) {
    throw new Error("Scheduled answer evidence is ambiguous between configured choices.");
  }
  const currentChoices = questionOptions(question.options).filter((option) =>
    currentEvidence.some((source) => quotedChoice(source, option.id) || quotedChoice(source, option.label)),
  );
  if (currentChoices.some((option) => option.id !== response)) {
    throw new Error("Scheduled answer evidence conflicts with current configured choices.");
  }
  const selected = questionOptions(question.options).find((option) => option.id === response);
  if (
    selected === undefined ||
    ![selected.id, selected.label].some((choice) => affirmativelyQuotedChoice(evidence, choice))
  ) {
    throw new Error("Scheduled answer evidence must state the submitted answer.");
  }
  return response;
}

function quotedChoice(evidence: string, choice: string): boolean {
  const escaped = choice.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(evidence);
}

function affirmativelyQuotedChoice(evidence: string, choice: string): boolean {
  const escaped = choice.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(
    `(?:\\b(?:is|are|was|were|equals?|means)\\s+|\\b(?:answer|choice|option|selection|decision)\\s*(?::|=|\\bis\\b)\\s*)${escaped}(?=$|[^\\p{L}\\p{N}_])`,
    "iu",
  ).test(evidence);
}

function selectedQuestionOption(options: readonly QuestionOption[], answer: string, caseInsensitiveLabel: boolean): QuestionOption | null {
  const id = options.find((option) => option.id === answer);
  if (id) return id;
  const label = caseInsensitiveLabel ? answer.toLocaleLowerCase() : answer;
  const matches = options.filter((option) => (caseInsensitiveLabel ? option.label.toLocaleLowerCase() : option.label) === label);
  return matches.length === 1 ? matches[0]! : null;
}
