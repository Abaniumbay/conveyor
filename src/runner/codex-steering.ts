import { existsSync } from "node:fs";

import { resolveFilesystemPath, resolvePathEnvironment } from "../core/paths";
import { prepareCodexEnvironment } from "../isolation/environment";
import { acquireScratch, assertNoHostTmpWritableRoots } from "../isolation/scratch";
import { codexLaunch, type EgressInput, type RunNetwork } from "../isolation/run-network";
import { CodexRunnerError, cleanupCodexRun, type CodexMcpConfiguration, withCleanupError } from "./codex";
import { EMPTY_USAGE } from "./result";

export interface CodexSteeringInput {
  command: string;
  workspace: string;
  /** Per-run directory that hosts the sanitized home. */
  artifactsDirectory: string;
  prompt: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  automaticApprovals: boolean;
  mcp?: CodexMcpConfiguration;
  env?: Record<string, string>;
  timeoutMs?: number;
  interruptGraceMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: unknown) => void;
  egress?: EgressInput;
  writableRoots?: string[];
  /** Run with only a fresh scratch filesystem instead of a steering workspace mount. */
  filesystem?: "scratch";
  /** Omit for disposable workspace-free scratch. */
  temporaryDirectory?: string;
}

export interface CodexSteeringResult {
  summary: string;
  sessionId: string | null;
  usage: typeof EMPTY_USAGE;
  durationMs: number;
  exitCode: number;
  stderr: string;
  cleanupError?: string;
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
function argumentsFor(input: CodexSteeringInput, extra: string[] = []): string[] {
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
  if (input.sandbox === "workspace-write") {
    args.push("-c", "sandbox_workspace_write.exclude_slash_tmp=true");
    if (input.writableRoots?.length) args.push("-c", `sandbox_workspace_write.writable_roots=[${input.writableRoots.map((root) => JSON.stringify(root)).join(",")}]`);
  }
  if (input.mcp) {
    args.push(
      "-c",
      `mcp_servers.conveyor.command=${JSON.stringify(input.mcp.command)}`,
      "-c",
      `mcp_servers.conveyor.args=[${input.mcp.args.map((value) => JSON.stringify(value)).join(",")}]`,
      "-c",
      "mcp_servers.conveyor.required=true",
      "-c",
      'mcp_servers.conveyor.default_tools_approval_mode="approve"',
    );
  }
  args.push(...extra, "-");
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
  let network: RunNetwork | null = null;
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    const confined = input.filesystem === "scratch";
    const agentWorkspace = confined ? scratch.path : workspace;
    const environment = await prepareCodexEnvironment({ artifactsDirectory, workspace: agentWorkspace, overrides: input.env });
    environment.TMPDIR = scratch.path;
    const resolvedEnvironment = resolvePathEnvironment(environment);
    const run = runInput.sandbox === "workspace-write"
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
        workspace: agentWorkspace,
        artifacts: artifactsDirectory,
        home: resolvedEnvironment.HOME!,
        scratch: scratch.path,
        writableGit: runInput.sandbox !== "read-only",
        writable: runInput.sandbox !== "read-only" ? [agentWorkspace, ...runInput.writableRoots] : [],
        runtime: input.mcp ? [input.mcp.command] : [],
      },
      buildArguments: (extra) => argumentsFor({ ...run, workspace: agentWorkspace }, extra),
    });
    network = launch.network;
    child = Bun.spawn(launch.argv, { cwd: agentWorkspace, env: launch.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    void child.exited.finally(() => network?.close());
  } catch (error) {
    const cleanupError = await cleanupCodexRun({ artifactsDirectory, network, scratch, env: input.env });
    throw withCleanupError(error, cleanupError);
  }
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
  let cleanupError: string | undefined;
  try {
    exitCode = await child.exited;
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    input.signal?.removeEventListener("abort", onAbort);
    cleanupError = await cleanupCodexRun({ artifactsDirectory, network, scratch, env: input.env });
  }
  const [{ raw, invalidLine }, stderr] = await Promise.all([stdout, stderrPromise]);
  const detail = [stderr.trim(), ...errors].filter(Boolean).join("\n");

  if (timedOut) {
    throw withCleanupError(new CodexRunnerError(`Codex steering timed out${detail ? `: ${detail}` : ""}`, "timeout", exitCode, stderr), cleanupError);
  }
  if (interrupted) {
    throw withCleanupError(new CodexRunnerError(`Codex steering was interrupted${detail ? `: ${detail}` : ""}`, "interrupted", exitCode, stderr), cleanupError);
  }
  if (exitCode !== 0) {
    const kind = USAGE_LIMIT_PATTERN.test(`${detail}\n${raw}`) ? "usage-limit" : "process";
    throw withCleanupError(new CodexRunnerError(`Codex steering exited with code ${exitCode}${detail ? `: ${detail}` : ""}`, kind, exitCode, stderr), cleanupError);
  }
  if (invalidLine) {
    throw withCleanupError(new CodexRunnerError(`Codex steering emitted invalid JSONL: ${invalidLine}`, "protocol", exitCode, stderr), cleanupError);
  }
  if (!summary.trim()) {
    throw withCleanupError(new CodexRunnerError("Codex steering completed without a final report", "protocol", exitCode, stderr), cleanupError);
  }
  return {
    summary: summary.trim(),
    sessionId,
    usage,
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    exitCode,
    stderr,
    ...(cleanupError ? { cleanupError } : {}),
  };
}
