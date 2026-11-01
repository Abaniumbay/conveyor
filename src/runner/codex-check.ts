import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { z } from "zod";

import type { CheckResult } from "../core/pipeline";
import { resolveFilesystemPath, resolvePathEnvironment } from "../core/paths";
import { prepareCodexEnvironment } from "../isolation/environment";
import { acquireScratch, assertNoHostTmpWritableRoots } from "../isolation/scratch";
import { codexLaunch, type EgressInput, type RunNetwork } from "../isolation/run-network";
import {
  CodexRunnerError,
  cleanupCodexRun,
  withCleanupError,
  type CodexMcpConfiguration,
  type CodexErrorKind,
} from "./codex";
import { EMPTY_USAGE, type RunEnvelope } from "./result";
import { writeOutputSchema } from "./output-schemas";

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
  /** Network isolation policy; absent keeps the legacy (environment-only) behaviour. */
  egress?: EgressInput;
  writableRoots?: string[];
  /** Persistent item scratch, or omitted for disposable runner-owned scratch. */
  temporaryDirectory?: string;
}

export interface CodexCheckRunResult extends CheckResult {
  sessionId: string | null;
  usage: RunEnvelope["usage"];
  durationMs: number;
  exitCode: number;
  stderr: string;
  cleanupError?: string;
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

const USAGE_LIMIT_PATTERN = /usage limit|rate limit|too many requests|\b429\b|quota/i;
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

function buildArguments(input: CodexCheckInput, outputFile: string, schemaFile: string, extra: string[] = []): string[] {
  const args = [
    "exec",
    "--json",
    "--color",
    "never",
    "--ephemeral",
    "--sandbox",
    input.egress ? "danger-full-access" : input.sandbox,
    "-C",
    input.workspace,
    "--output-schema",
    schemaFile,
    "-o",
    outputFile,
  ];
  if (input.automaticApprovals && input.sandbox === "workspace-write" && !input.egress) {
    args.push("--approve-for-me");
  }
  if (input.sandbox === "workspace-write") {
    args.push("-c", "sandbox_workspace_write.exclude_slash_tmp=true");
    if (input.writableRoots?.length) args.push("-c", `sandbox_workspace_write.writable_roots=${tomlArray(input.writableRoots)}`);
  }
  if (input.model) args.push("--model", input.model);
  if (input.effort) {
    args.push("-c", `model_reasoning_effort=${tomlString(input.effort)}`);
  }
  args.push(
    ...extra,
    "-c",
    `mcp_servers.conveyor.command=${tomlString(input.mcp.command)}`,
    "-c",
    `mcp_servers.conveyor.args=${tomlArray(input.mcp.args)}`,
    "-c",
    "mcp_servers.conveyor.required=true",
    "-c",
    'mcp_servers.conveyor.default_tools_approval_mode="approve"',
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
  const artifactsDirectory = resolveFilesystemPath(input.artifactsDirectory);
  const workspace = resolveFilesystemPath(input.workspace);
  assertNoHostTmpWritableRoots(input.writableRoots);
  const runInput = {
    ...input,
    artifactsDirectory,
    workspace,
    writableRoots: (input.writableRoots ?? []).filter(existsSync).map(resolveFilesystemPath),
  };
  const scratch = await acquireScratch(input.temporaryDirectory);
  const outputFile = path.join(
    artifactsDirectory,
    `codex-check-${randomUUID()}.json`,
  );
  const startedAt = performance.now();
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  let network: RunNetwork | null = null;
  let schemaFile: string;
  try {
    schemaFile = await writeOutputSchema(artifactsDirectory, "check");
    const environment = await prepareCodexEnvironment({
      artifactsDirectory,
      workspace,
      overrides: input.env,
    });
    environment.TMPDIR = scratch.path;
    const resolvedEnvironment = resolvePathEnvironment(environment);
    const run =
      runInput.sandbox === "workspace-write"
        ? {
            ...runInput,
            writableRoots: [
              ...runInput.writableRoots,
              resolvedEnvironment.HOME!,
              scratch.path,
            ],
          }
        : runInput;
    const launch = await codexLaunch({
      command: input.command,
      environment: resolvedEnvironment,
      artifactsDirectory,
      egress: runInput.egress,
      privateTmp: runInput.sandbox === "danger-full-access",
      filesystem: {
        command: input.command,
        env: resolvedEnvironment,
        workspace,
        artifacts: artifactsDirectory,
        home: resolvedEnvironment.HOME!,
        scratch: scratch.path,
        writableGit: runInput.sandbox !== "read-only",
        writable: runInput.sandbox !== "read-only" ? [workspace, ...runInput.writableRoots] : [],
        runtime: [input.mcp.command],
      },
      buildArguments: (extra) => buildArguments(run, outputFile, schemaFile, extra),
    });
    network = launch.network;
    child = Bun.spawn(launch.argv, { cwd: workspace, env: launch.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    // Release the per-run network whenever the process ends, even if later setup throws.
    void child.exited.finally(() => network?.close());
  } catch (error) {
    const cleanupError = await cleanupCodexRun({ artifactsDirectory, network, scratch, env: input.env });
    throw withCleanupError(new CodexRunnerError(
      `Could not start Codex: ${error instanceof Error ? error.message : String(error)}`,
      "process",
      null,
      "",
      { cause: error },
    ), cleanupError);
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
  let cleanupError: string | undefined;
  try {
    exitCode = await child.exited;
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    input.signal?.removeEventListener("abort", onAbort);
    cleanupError = await cleanupCodexRun({ artifactsDirectory, network, scratch, env: input.env });
  }
  const [{ raw, invalidLine }, stderr] = await Promise.all([
    stdoutPromise,
    stderrPromise,
  ]);
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  const failureDetail = [stderr.trim(), ...messages].filter(Boolean).join("\n");

  if (timedOut) {
    throw withCleanupError(new CodexRunnerError(
      `Codex verifier timed out after ${input.timeoutMs}ms${failureDetail ? `: ${failureDetail}` : ""}`,
      "timeout",
      exitCode,
      stderr,
    ), cleanupError);
  }
  if (interrupted) {
    throw withCleanupError(new CodexRunnerError(
      `Codex verifier was interrupted${failureDetail ? `: ${failureDetail}` : ""}`,
      "interrupted",
      exitCode,
      stderr,
    ), cleanupError);
  }
  if (exitCode !== 0) {
    const kind = errorKind(`${failureDetail}\n${raw}`);
    throw withCleanupError(new CodexRunnerError(
      `Codex verifier exited with code ${exitCode}${failureDetail ? `: ${failureDetail}` : ""}`,
      kind,
      exitCode,
      stderr,
    ), cleanupError);
  }
  if (invalidLine) {
    throw withCleanupError(new CodexRunnerError(
      `Codex verifier emitted invalid JSONL: ${invalidLine}`,
      "protocol",
      exitCode,
      stderr,
    ), cleanupError);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(outputFile, "utf8"));
  } catch (error) {
    throw withCleanupError(new CodexRunnerError(
      `Codex verifier did not produce valid structured output: ${error instanceof Error ? error.message : String(error)}`,
      "protocol",
      exitCode,
      stderr,
      { cause: error },
    ), cleanupError);
  }
  const parsed = checkResultSchema.safeParse(decoded);
  if (!parsed.success) {
    throw withCleanupError(new CodexRunnerError(
      `Codex verifier structured output failed validation: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "result"}: ${issue.message}`)
        .join("; ")}`,
      "protocol",
      exitCode,
      stderr,
    ), cleanupError);
  }
  const { version: _version, ...check } = parsed.data;
  return {
    ...check,
    sessionId,
    usage,
    durationMs,
    exitCode,
    stderr,
    ...(cleanupError ? { cleanupError } : {}),
  };
}
