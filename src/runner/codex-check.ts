import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { CheckResult } from "../core/pipeline";
import {
  CodexRunnerError,
  type CodexMcpConfiguration,
  type CodexErrorKind,
} from "./codex";
import { EMPTY_USAGE, type RunEnvelope } from "./result";

export interface CodexCheckInput {
  command: string;
  workspace: string;
  artifactsDirectory: string;
  prompt: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  automaticApprovals: boolean;
  mcp: CodexMcpConfiguration;
  env?: Record<string, string>;
  timeoutMs?: number;
  interruptGraceMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: unknown) => void;
}

export interface CodexCheckRunResult extends CheckResult {
  sessionId: string | null;
  usage: RunEnvelope["usage"];
  durationMs: number;
  exitCode: number;
  stderr: string;
}

export const checkResultSchema = z
  .object({
    version: z.literal(1),
    decision: z.enum(["pass", "fail"]),
    status: z.string().trim().min(1),
    reason: z.string().trim().min(1).nullable(),
    evidence: z.array(z.string().trim().min(1)),
    requiredFixes: z.array(z.string().trim().min(1)),
    criteria: z.array(
      z
        .object({
          id: z.string().trim().min(1),
          passed: z.boolean(),
          evidence: z.string().trim().min(1),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.decision === "fail" && result.reason === null) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "a failed check requires a reason",
      });
    }
    if (
      result.decision === "fail" &&
      result.status !== "rejected" &&
      result.status !== "needs-input" &&
      result.requiredFixes.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["requiredFixes"],
        message: "a failed check requires at least one required fix",
      });
    }
  });

type CheckEvent = {
  type?: string;
  thread_id?: string;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  message?: string;
};

const OUTPUT_SCHEMA = path.join(import.meta.dir, "schemas/check-result.json");
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

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(",")}]`;
}

async function consumeJsonLines(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: CheckEvent) => void,
): Promise<{ raw: string; invalidLine: string | null }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let raw = "";
  let invalidLine: string | null = null;
  const consume = (line: string): void => {
    if (line.trim().length === 0) return;
    try {
      onEvent(JSON.parse(line) as CheckEvent);
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

function buildArguments(input: CodexCheckInput, outputFile: string): string[] {
  const args = [
    "exec",
    "--json",
    "--color",
    "never",
    "--ephemeral",
    "--sandbox",
    input.sandbox,
    "-C",
    input.workspace,
    "--output-schema",
    OUTPUT_SCHEMA,
    "-o",
    outputFile,
  ];
  if (input.automaticApprovals && input.sandbox === "workspace-write") {
    args.push("--approve-for-me");
  }
  if (input.model) args.push("--model", input.model);
  if (input.effort) {
    args.push("-c", `model_reasoning_effort=${tomlString(input.effort)}`);
  }
  args.push(
    "-c",
    `mcp_servers.conveyor.command=${tomlString(input.mcp.command)}`,
    "-c",
    `mcp_servers.conveyor.args=${tomlArray(input.mcp.args)}`,
    "-c",
    "mcp_servers.conveyor.required=true",
    "-",
  );
  return args;
}

function errorKind(detail: string): CodexErrorKind {
  return USAGE_LIMIT_PATTERN.test(detail) ? "usage-limit" : "process";
}

export async function runCodexCheck(
  input: CodexCheckInput,
): Promise<CodexCheckRunResult> {
  await mkdir(input.artifactsDirectory, { recursive: true });
  const outputFile = path.join(
    input.artifactsDirectory,
    `codex-check-${randomUUID()}.json`,
  );
  const startedAt = performance.now();
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn([input.command, ...buildArguments(input, outputFile)], {
      cwd: input.workspace,
      env: environment(input.env),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new CodexRunnerError(
      `Could not start Codex: ${error instanceof Error ? error.message : String(error)}`,
      "process",
      null,
      "",
      { cause: error },
    );
  }
  child.stdin.write(input.prompt);
  child.stdin.end();

  let sessionId: string | null = null;
  const usage = { ...EMPTY_USAGE };
  const messages: string[] = [];
  const stdoutPromise = consumeJsonLines(child.stdout, (event) => {
    input.onEvent?.(event);
    if (event.type === "thread.started" && event.thread_id) {
      sessionId = event.thread_id;
    }
    if (event.type === "turn.completed" && event.usage) {
      usage.inputTokens += event.usage.input_tokens ?? 0;
      usage.outputTokens += event.usage.output_tokens ?? 0;
      usage.cachedTokens += event.usage.cached_input_tokens ?? 0;
    }
    if (event.type === "error" && event.message) messages.push(event.message);
  });
  const stderrPromise = new Response(child.stderr).text();

  let timedOut = false;
  let interrupted = input.signal?.aborted ?? false;
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
    interrupted = true;
    stop();
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (interrupted) stop();

  let exitCode: number;
  try {
    exitCode = await child.exited;
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    input.signal?.removeEventListener("abort", onAbort);
  }
  const [{ raw, invalidLine }, stderr] = await Promise.all([
    stdoutPromise,
    stderrPromise,
  ]);
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  const failureDetail = [stderr.trim(), ...messages].filter(Boolean).join("\n");

  if (timedOut) {
    throw new CodexRunnerError(
      `Codex verifier timed out after ${input.timeoutMs}ms${failureDetail ? `: ${failureDetail}` : ""}`,
      "timeout",
      exitCode,
      stderr,
    );
  }
  if (interrupted) {
    throw new CodexRunnerError(
      `Codex verifier was interrupted${failureDetail ? `: ${failureDetail}` : ""}`,
      "interrupted",
      exitCode,
      stderr,
    );
  }
  if (exitCode !== 0) {
    const kind = errorKind(`${failureDetail}\n${raw}`);
    throw new CodexRunnerError(
      `Codex verifier exited with code ${exitCode}${failureDetail ? `: ${failureDetail}` : ""}`,
      kind,
      exitCode,
      stderr,
    );
  }
  if (invalidLine) {
    throw new CodexRunnerError(
      `Codex verifier emitted invalid JSONL: ${invalidLine}`,
      "protocol",
      exitCode,
      stderr,
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(outputFile, "utf8"));
  } catch (error) {
    throw new CodexRunnerError(
      `Codex verifier did not produce valid structured output: ${error instanceof Error ? error.message : String(error)}`,
      "protocol",
      exitCode,
      stderr,
      { cause: error },
    );
  }
  const parsed = checkResultSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new CodexRunnerError(
      `Codex verifier structured output failed validation: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "result"}: ${issue.message}`)
        .join("; ")}`,
      "protocol",
      exitCode,
      stderr,
    );
  }
  const { version: _version, ...check } = parsed.data;
  return {
    ...check,
    sessionId,
    usage,
    durationMs,
    exitCode,
    stderr,
  };
}
