import { producerResultSchema, EMPTY_USAGE, UNAVAILABLE_COST, type RunEnvelope } from "./result";
import { resolveFilesystemPath, resolvePathEnvironment } from "../core/paths";

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

export interface ProcessOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Canonicalize the filesystem references in the standard script-run context. */
function resolveProcessInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const resolved = { ...(input as Record<string, unknown>) };
  if (typeof resolved.workspace === "string") {
    resolved.workspace = resolveFilesystemPath(resolved.workspace);
  } else if (resolved.workspace && typeof resolved.workspace === "object" && !Array.isArray(resolved.workspace)) {
    const workspace = { ...(resolved.workspace as Record<string, unknown>) };
    if (typeof workspace.path === "string") workspace.path = resolveFilesystemPath(workspace.path);
    resolved.workspace = workspace;
  }
  if (resolved.repository && typeof resolved.repository === "object" && !Array.isArray(resolved.repository)) {
    const repository = { ...(resolved.repository as Record<string, unknown>) };
    if (typeof repository.folder === "string") repository.folder = resolveFilesystemPath(repository.folder);
    resolved.repository = repository;
  }
  return resolved;
}

/** Runs a command with the JSON input on stdin; a timeout, interrupt or non-zero exit throws RunnerProcessError. */
export async function runProcess(input: JsonProcessInput): Promise<ProcessOutput> {
  if (input.command.length === 0) throw new Error("runner command cannot be empty");
  const cwd = resolveFilesystemPath(input.cwd);
  const environment = resolvePathEnvironment(input.env ? { ...process.env, ...input.env } : process.env);
  const startedAt = performance.now();
  const child = Bun.spawn(input.command, {
    cwd,
    env: environment,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });

  child.stdin.write(JSON.stringify(resolveProcessInput(input.input)));
  child.stdin.end();

  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  let timedOut = false;
  let aborted = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

  const signalProcessTree = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (!isErrno(error, "ESRCH")) throw error;
    }
    if (child.exitCode === null) {
      try {
        child.kill(signal);
      } catch (error) {
        if (!isErrno(error, "ESRCH")) throw error;
      }
    }
  };

  const stop = (): void => {
    signalProcessTree("SIGTERM");
    forceKillTimer ??= setTimeout(() => signalProcessTree("SIGKILL"), input.interruptGraceMs ?? 10_000);
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
  let stdout: string;
  let stderr: string;
  try {
    exitCode = await child.exited;
    [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    input.signal?.removeEventListener("abort", onAbort);
  }

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

  return { stdout, stderr, exitCode, durationMs };
}

export async function runJsonProcess(input: JsonProcessInput): Promise<RunEnvelope> {
  const { stdout, stderr, exitCode, durationMs } = await runProcess(input);
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
