import { CodexRunnerError } from "./codex";
import { EMPTY_USAGE } from "./result";

export interface CodexSteeringInput {
  command: string;
  workspace: string;
  prompt: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  automaticApprovals: boolean;
  env?: Record<string, string>;
  timeoutMs?: number;
  interruptGraceMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: unknown) => void;
}

export interface CodexSteeringResult {
  summary: string;
  sessionId: string | null;
  usage: typeof EMPTY_USAGE;
  durationMs: number;
  exitCode: number;
  stderr: string;
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  item?: {
    type?: string;
    text?: string;
  };
}

const USAGE_LIMIT_PATTERN = /usage limit|rate limit|too many requests|\b429\b|quota/i;
const INHERITED_ENVIRONMENT = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "COLORTERM",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "CODEX_HOME",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
] as const;

function environment(overrides?: Record<string, string>): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const key of INHERITED_ENVIRONMENT) {
    const value = process.env[key];
    if (value !== undefined) selected[key] = value;
  }
  return { ...selected, ...overrides };
}

function argumentsFor(input: CodexSteeringInput): string[] {
  const args = [
    "exec",
    "--json",
    "--color",
    "never",
    "--ephemeral",
    "--skip-git-repo-check",
    "-C",
    input.workspace,
  ];
  if (input.automaticApprovals && input.sandbox === "workspace-write") {
    args.push("--approve-for-me");
  } else {
    args.push("--sandbox", input.sandbox);
  }
  if (input.model) args.push("--model", input.model);
  if (input.effort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(input.effort)}`);
  }
  args.push("-");
  return args;
}

async function consumeJsonLines(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: CodexEvent) => void,
): Promise<{ raw: string; invalidLine: string | null }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let raw = "";
  let invalidLine: string | null = null;
  const consume = (line: string) => {
    if (!line.trim()) return;
    try {
      onEvent(JSON.parse(line) as CodexEvent);
    } catch {
      invalidLine ??= line;
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    raw += chunk;
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consume(line);
  }
  const tail = buffer + decoder.decode();
  raw += tail;
  consume(tail);
  return { raw, invalidLine };
}

export async function runCodexSteering(
  input: CodexSteeringInput,
): Promise<CodexSteeringResult> {
  const started = performance.now();
  const child = Bun.spawn([input.command, ...argumentsFor(input)], {
    cwd: input.workspace,
    env: environment(input.env),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(input.prompt);
  child.stdin.end();

  let sessionId: string | null = null;
  let summary = "";
  const usage = { ...EMPTY_USAGE };
  const errors: string[] = [];
  const stdout = consumeJsonLines(child.stdout, (event) => {
    input.onEvent?.(event);
    if (event.type === "thread.started" && event.thread_id) sessionId = event.thread_id;
    if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
      summary = event.item.text;
    }
    if (event.type === "turn.completed" && event.usage) {
      usage.inputTokens += event.usage.input_tokens ?? 0;
      usage.outputTokens += event.usage.output_tokens ?? 0;
      usage.cachedTokens += event.usage.cached_input_tokens ?? 0;
    }
    if (event.type === "error" && event.message) errors.push(event.message);
  });
  const stderrPromise = new Response(child.stderr).text();

  let timedOut = false;
  let interrupted = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(
      () => child.exitCode === null && child.kill("SIGKILL"),
      input.interruptGraceMs ?? 10_000,
    );
  };
  const timeoutTimer = input.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        stop();
      }, input.timeoutMs)
    : undefined;
  const onAbort = () => {
    interrupted = true;
    stop();
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });

  let exitCode: number;
  try {
    exitCode = await child.exited;
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    input.signal?.removeEventListener("abort", onAbort);
  }
  const [{ raw, invalidLine }, stderr] = await Promise.all([stdout, stderrPromise]);
  const detail = [stderr.trim(), ...errors].filter(Boolean).join("\n");

  if (timedOut) {
    throw new CodexRunnerError(`Codex steering timed out${detail ? `: ${detail}` : ""}`, "timeout", exitCode, stderr);
  }
  if (interrupted) {
    throw new CodexRunnerError(`Codex steering was interrupted${detail ? `: ${detail}` : ""}`, "interrupted", exitCode, stderr);
  }
  if (exitCode !== 0) {
    const kind = USAGE_LIMIT_PATTERN.test(`${detail}\n${raw}`) ? "usage-limit" : "process";
    throw new CodexRunnerError(`Codex steering exited with code ${exitCode}${detail ? `: ${detail}` : ""}`, kind, exitCode, stderr);
  }
  if (invalidLine) {
    throw new CodexRunnerError(`Codex steering emitted invalid JSONL: ${invalidLine}`, "protocol", exitCode, stderr);
  }
  if (!summary.trim()) {
    throw new CodexRunnerError("Codex steering completed without a final report", "protocol", exitCode, stderr);
  }
  return {
    summary: summary.trim(),
    sessionId,
    usage,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    exitCode,
    stderr,
  };
}
