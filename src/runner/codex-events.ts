import { EMPTY_USAGE } from "./result";
import { isUsageLimitFailure } from "./harness-error";
import { JsonLinesParser } from "./process";

interface CodexEvent {
  type?: string;
  thread_id?: string;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  message?: string;
}

/** Shared interpretation of Codex's JSONL event metadata across run modes. */
export function codexEventStream(onEvent?: (event: unknown) => void) {
  let sessionId: string | null = null;
  const usage = { ...EMPTY_USAGE };
  const errors: string[] = [];
  const parser = new JsonLinesParser<CodexEvent>((event) => {
    onEvent?.(event);
    if (event.type === "thread.started" && event.thread_id) sessionId = event.thread_id;
    if (event.type === "turn.completed" && event.usage) {
      usage.inputTokens += event.usage.input_tokens ?? 0;
      usage.outputTokens += event.usage.output_tokens ?? 0;
      usage.cachedTokens += event.usage.cached_input_tokens ?? 0;
    }
    if (event.type === "error" && event.message) errors.push(event.message);
  });
  return {
    parser,
    usage,
    errors,
    get sessionId() { return sessionId; },
  };
}

export function codexFailureKind(stderr: string, stdout: string, errors: readonly string[]) {
  return isUsageLimitFailure([stderr.trim(), ...errors, stdout].filter(Boolean).join("\n"))
    ? "usage-limit" as const
    : "process" as const;
}
