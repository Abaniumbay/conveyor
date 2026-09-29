import { producerResultSchema, EMPTY_USAGE, UNAVAILABLE_COST, type RunEnvelope } from "./result";

export interface JsonProcessInput {
  command: string[];
  cwd: string;
  input: unknown;
  env?: Record<string, string>;
  timeoutMs?: number;
  interruptGraceMs?: number;
  signal?: AbortSignal;
}

export class RunnerProcessError extends Error {
  override readonly name = "RunnerProcessError";

  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export class RunnerProtocolError extends Error {
  override readonly name = "RunnerProtocolError";

  constructor(message: string, readonly stdout: string) {
    super(message);
  }
}

function processErrorMessage(prefix: string, stderr: string): string {
  const detail = stderr.trim();
  return detail.length > 0 ? `${prefix}: ${detail}` : prefix;
}

export async function runJsonProcess(input: JsonProcessInput): Promise<RunEnvelope> {
  if (input.command.length === 0) throw new Error("runner command cannot be empty");
  const startedAt = performance.now();
  const child = Bun.spawn(input.command, {
    cwd: input.cwd,
    env: input.env ? { ...process.env, ...input.env } : process.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  child.stdin.write(JSON.stringify(input.input));
  child.stdin.end();

  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  let timedOut = false;
  let aborted = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

  const stop = (): void => {
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
  const onAbort = (): void => {
    aborted = true;
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

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));

  if (timedOut) {
    throw new RunnerProcessError(
      processErrorMessage(
        `process timed out after ${input.timeoutMs}ms`,
        stderr,
      ),
      exitCode,
      stderr,
    );
  }
  if (aborted) {
    throw new RunnerProcessError(
      processErrorMessage("process was interrupted", stderr),
      exitCode,
      stderr,
    );
  }
  if (exitCode !== 0) {
    throw new RunnerProcessError(
      processErrorMessage(`process exited with code ${exitCode}`, stderr),
      exitCode,
      stderr,
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch (error) {
    throw new RunnerProtocolError(
      `runner stdout must contain exactly one JSON object: ${error instanceof Error ? error.message : String(error)}`,
      stdout,
    );
  }
  const parsed = producerResultSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new RunnerProtocolError(
      `runner result is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "result"}: ${issue.message}`)
        .join("; ")}`,
      stdout,
    );
  }

  const result = parsed.data;
  return {
    stageResult: {
      outcome: result.outcome,
      status: result.status,
      summary: result.summary,
      reason: result.reason,
      metrics: result.metrics,
    },
    sessionId: result.sessionId ?? null,
    usage: result.usage ?? { ...EMPTY_USAGE },
    cost: result.cost ?? { ...UNAVAILABLE_COST },
    durationMs,
    exitCode,
    artifacts: result.artifacts,
    stderr,
  };
}
