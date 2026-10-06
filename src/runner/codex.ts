import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { prepareCodexEnvironment } from "../isolation/environment";
import { CODEX_CONTROL_PLANE_HOSTS, codexLaunch, type EgressInput, type RunNetwork } from "../isolation/run-network";
import {
  EMPTY_USAGE,
  UNAVAILABLE_COST,
  producerResultSchema,
  type RunEnvelope,
} from "./result";
import { writeOutputSchema } from "./output-schemas";

export interface CodexMcpConfiguration {
  command: string;
  args: string[];
}

export interface CodexRunInput {
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
  /** Keep the session on disk so it can be resumed later (the default run is ephemeral). */
  persistSession?: boolean;
  /** Continue this session with `codex exec resume` instead of starting a new one. */
  resumeSessionId?: string;
  /**
   * Network isolation: when set, codex runs inside a network-less sandbox whose only exits are the
   * allowlisted proxies. Absent means the legacy behaviour (sanitized environment only).
   */
  egress?: EgressInput;
  /** Live web search, plus network for the agent's commands under workspace-write. */
  network?: boolean;
  /** Directories outside the workspace that the agent's commands may write (workspace-write only). */
  writableRoots?: string[];
  /** Extra Codex settings, each passed as `-c key=value`. */
  config?: Record<string, CodexConfigValue>;
  /** MCP servers beside Conveyor's own. They are optional: one that fails to start does not fail the run. */
  mcpServers?: Record<string, CodexMcpServer>;
}

export type CodexConfigValue = string | number | boolean;

export interface CodexMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
  startupTimeoutSec?: number;
  enabledTools?: string[];
}

export { CODEX_CONTROL_PLANE_HOSTS };

export type CodexErrorKind =
  | "usage-limit"
  | "process"
  | "protocol"
  | "timeout"
  | "interrupted";

export class CodexRunnerError extends Error {
  override readonly name = "CodexRunnerError";

  constructor(
    message: string,
    readonly kind: CodexErrorKind,
    readonly exitCode: number | null,
    readonly stderr: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

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

const USAGE_LIMIT_PATTERN = /usage limit|rate limit|too many requests|\b429\b|quota/i;
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(",")}]`;
}

function tomlValue(value: CodexConfigValue): string {
  return typeof value === "string" ? tomlString(value) : String(value);
}

function tomlInlineTable(values: Record<string, string>): string {
  return `{${Object.entries(values).map(([key, value]) => `${key}=${tomlString(value)}`).join(",")}}`;
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

  const consume = (line: string): void => {
    if (line.trim().length === 0) return;
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

// Web search runs on the model side, so a read-only agent can have it too. Network for commands and
// extra writable roots are workspace-write settings; read-only has neither.
function accessArguments(input: CodexRunInput): string[] {
  const args: string[] = [];
  if (input.network) args.push("-c", `web_search=${tomlString("live")}`);
  if (input.sandbox !== "workspace-write") return args;
  if (input.network) args.push("-c", "sandbox_workspace_write.network_access=true");
  if (input.writableRoots?.length) args.push("-c", `sandbox_workspace_write.writable_roots=${tomlArray(input.writableRoots)}`);
  return args;
}

function configArguments(input: CodexRunInput): string[] {
  return Object.entries(input.config ?? {}).flatMap(([key, value]) => ["-c", `${key}=${tomlValue(value)}`]);
}

function mcpArguments(input: CodexRunInput): string[] {
  const args = [
    "-c",
    `mcp_servers.conveyor.command=${tomlString(input.mcp.command)}`,
    "-c",
    `mcp_servers.conveyor.args=${tomlArray(input.mcp.args)}`,
    "-c",
    "mcp_servers.conveyor.required=true",
    "-c",
    'mcp_servers.conveyor.default_tools_approval_mode="approve"',
  ];
  for (const [name, server] of Object.entries(input.mcpServers ?? {})) {
    const key = `mcp_servers.${name}`;
    args.push("-c", `${key}.command=${tomlString(server.command)}`, "-c", `${key}.args=${tomlArray(server.args)}`);
    if (Object.keys(server.env).length > 0) args.push("-c", `${key}.env=${tomlInlineTable(server.env)}`);
    if (server.startupTimeoutSec !== undefined) args.push("-c", `${key}.startup_timeout_sec=${server.startupTimeoutSec}`);
    if (server.enabledTools) args.push("-c", `${key}.enabled_tools=${tomlArray(server.enabledTools)}`);
    args.push("-c", `${key}.default_tools_approval_mode="approve"`);
  }
  return args;
}

// `codex exec resume` rejects -C, --color, --sandbox and --approve-for-me, so a resumed run
// takes the working directory from the spawn cwd and the sandbox and approvals from -c overrides.
function resumeArguments(input: CodexRunInput, sessionId: string, outputFile: string, schemaFile: string, extra: string[]): string[] {
  const args = ["exec", "resume", "--json", "--output-schema", schemaFile, "-o", outputFile];
  args.push("-c", `sandbox_mode=${tomlString(input.sandbox)}`);
  if (input.automaticApprovals && input.sandbox === "workspace-write") {
    args.push("-c", `approvals_reviewer=${tomlString("auto_review")}`);
  }
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("-c", `model_reasoning_effort=${tomlString(input.effort)}`);
  args.push(...accessArguments(input), ...configArguments(input), ...extra, ...mcpArguments(input), sessionId, "-");
  return args;
}

function buildArguments(input: CodexRunInput, outputFile: string, schemaFile: string, extra: string[] = []): string[] {
  if (input.resumeSessionId) return resumeArguments(input, input.resumeSessionId, outputFile, schemaFile, extra);
  const args = ["exec", "--json", "--color", "never"];
  if (!input.persistSession) args.push("--ephemeral");
  args.push("-C", input.workspace, "--output-schema", schemaFile, "-o", outputFile);
  if (input.automaticApprovals && input.sandbox === "workspace-write") {
    args.push("--approve-for-me");
  } else {
    args.push("--sandbox", input.sandbox);
  }
  if (input.model) args.push("--model", input.model);
  if (input.effort) {
    args.push("-c", `model_reasoning_effort=${tomlString(input.effort)}`);
  }
  args.push(...accessArguments(input), ...configArguments(input), ...extra, ...mcpArguments(input), "-");
  return args;
}

function spawnPiped(argv: string[], cwd: string, env: Record<string, string>) {
  return Bun.spawn(argv, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}

export async function runCodex(input: CodexRunInput): Promise<RunEnvelope> {
  await mkdir(input.artifactsDirectory, { recursive: true });
  const outputFile = path.join(
    input.artifactsDirectory,
    `codex-result-${randomUUID()}.json`,
  );
  const schemaFile = await writeOutputSchema(input.artifactsDirectory, "producer");
  const startedAt = performance.now();
  let network: RunNetwork | null = null;
  let child: ReturnType<typeof spawnPiped>;
  try {
    const environment = await prepareCodexEnvironment({ artifactsDirectory: input.artifactsDirectory, workspace: input.workspace, overrides: input.env });
    const launch = await codexLaunch({
      command: input.command,
      environment,
      artifactsDirectory: input.artifactsDirectory,
      egress: input.egress,
      buildArguments: (extra) => buildArguments(input, outputFile, schemaFile, extra),
    });
    network = launch.network;
    child = spawnPiped(launch.argv, input.workspace, launch.env);
    // Release the per-run network whenever the process ends, even if later setup throws.
    void child.exited.finally(() => network?.close());
  } catch (error) {
    await network?.close();
    throw error;
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
  let interrupted = false;
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

  let exitCode: number;
  try {
    exitCode = await child.exited;
  } finally {
    await network?.close();
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
      `Codex timed out after ${input.timeoutMs}ms${failureDetail ? `: ${failureDetail}` : ""}`,
      "timeout",
      exitCode,
      stderr,
    );
  }
  if (interrupted) {
    throw new CodexRunnerError(
      `Codex was interrupted${failureDetail ? `: ${failureDetail}` : ""}`,
      "interrupted",
      exitCode,
      stderr,
    );
  }
  if (exitCode !== 0) {
    const kind = USAGE_LIMIT_PATTERN.test(`${failureDetail}\n${raw}`)
      ? "usage-limit"
      : "process";
    throw new CodexRunnerError(
      `Codex exited with code ${exitCode}${failureDetail ? `: ${failureDetail}` : ""}`,
      kind,
      exitCode,
      stderr,
    );
  }
  if (invalidLine) {
    throw new CodexRunnerError(
      `Codex emitted invalid JSONL: ${invalidLine}`,
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
      `Codex did not produce valid structured output: ${error instanceof Error ? error.message : String(error)}`,
      "protocol",
      exitCode,
      stderr,
      { cause: error },
    );
  }
  const parsed = producerResultSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new CodexRunnerError(
      `Codex structured output failed validation: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "result"}: ${issue.message}`)
        .join("; ")}`,
      "protocol",
      exitCode,
      stderr,
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
    sessionId,
    usage,
    cost: { ...UNAVAILABLE_COST },
    durationMs,
    exitCode,
    artifacts: result.artifacts,
    stderr,
  };
}
