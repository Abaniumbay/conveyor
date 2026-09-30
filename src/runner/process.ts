import { HarnessError, type HarnessErrorKind } from "./harness-error";

export interface SupervisedProcessInput {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  timeoutMs?: number;
  interruptGraceMs?: number;
  signal?: AbortSignal;
  onStdoutChunk?: (chunk: string) => void;
}

export interface SupervisedProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  interrupted: boolean;
  timedOut: boolean;
}

export interface ParsedJsonLines<T> {
  events: T[];
  invalidLine: string | null;
}

export class JsonLinesParser<T = Record<string, unknown>> {
  readonly events: T[] = [];
  invalidLine: string | null = null;
  #buffer = "";

  constructor(private readonly onEvent?: (event: T) => void) {}

  write(chunk: string): void {
    this.#buffer += chunk;
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    for (const line of lines) this.#consume(line);
  }

  end(): ParsedJsonLines<T> {
    this.#consume(this.#buffer);
    this.#buffer = "";
    return { events: this.events, invalidLine: this.invalidLine };
  }

  #consume(line: string): void {
    if (!line.trim()) return;
    let event: T;
    try {
      event = JSON.parse(line) as T;
    } catch {
      this.invalidLine ??= line;
      return;
    }
    this.events.push(event);
    this.onEvent?.(event);
  }
}

export function parseJsonLines<T = Record<string, unknown>>(raw: string): ParsedJsonLines<T> {
  const parser = new JsonLinesParser<T>();
  parser.write(raw);
  return parser.end();
}

async function read(
  stream: ReadableStream<Uint8Array>,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    output += chunk;
    onChunk?.(chunk);
  }
  const tail = decoder.decode();
  output += tail;
  if (tail) onChunk?.(tail);
  return output;
}

export async function superviseProcess(input: SupervisedProcessInput): Promise<SupervisedProcessResult> {
  if (input.signal?.aborted) {
    throw new HarnessError("The process was interrupted before it started", "interrupted");
  }
  const startedAt = performance.now();
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn(input.command, {
      cwd: input.cwd,
      env: input.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new HarnessError(
      `Could not start ${input.command[0] ?? "process"}: ${error instanceof Error ? error.message : String(error)}`,
      "process",
      { cause: error },
    );
  }

  let interrupted = false;
  let timedOut = false;
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
  if (input.signal?.aborted) onAbort();
  const stdoutPromise = read(child.stdout, input.onStdoutChunk);
  const stderrPromise = read(child.stderr);
  let inputError: unknown;
  try {
    child.stdin.write(input.stdin);
    child.stdin.end();
  } catch (error) {
    inputError = error;
    stop();
    try { child.stdin.end(); } catch {}
  }
  let exitCode: number;
  try {
    exitCode = await child.exited;
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    input.signal?.removeEventListener("abort", onAbort);
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  if (inputError) {
    throw new HarnessError(
      `Could not send input to ${input.command[0] ?? "process"}: ${inputError instanceof Error ? inputError.message : String(inputError)}`,
      "process",
      { cause: inputError },
    );
  }
  if (timedOut || interrupted) {
    const kind: HarnessErrorKind = timedOut ? "timeout" : "interrupted";
    throw new HarnessError(
      `${input.command[0] ?? "Process"} ${kind === "timeout" ? "timed out" : "was interrupted"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
      kind,
    );
  }
  return { stdout, stderr, exitCode, durationMs, interrupted, timedOut };
}
