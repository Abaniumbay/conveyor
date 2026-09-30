import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HarnessError, type HarnessErrorKind } from "./harness-error";

import {
  UNAVAILABLE_COST,
  producerResultSchema,
  type RunEnvelope,
} from "./result";
import { superviseProcess } from "./process";
import { codexEventStream, codexFailureKind } from "./codex-events";

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
}

export type CodexErrorKind = HarnessErrorKind;

export class CodexRunnerError extends HarnessError {
  override readonly name = "CodexRunnerError";

  constructor(
    message: string,
    kind: CodexErrorKind,
    readonly exitCode: number | null,
    readonly stderr: string,
    options?: ErrorOptions,
  ) {
    super(message, kind, options);
  }
}

const OUTPUT_SCHEMA = path.join(import.meta.dir, "schemas/producer-result.json");
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

function buildArguments(input: CodexRunInput, outputFile: string): string[] {
  const args = [
    "exec",
    "--json",
    "--color",
    "never",
    "--ephemeral",
    "-C",
    input.workspace,
    "--output-schema",
    OUTPUT_SCHEMA,
    "-o",
    outputFile,
  ];
  if (input.automaticApprovals && input.sandbox === "workspace-write") {
    args.push("--approve-for-me");
  } else {
    args.push("--sandbox", input.sandbox);
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
    "-c",
    'mcp_servers.conveyor.default_tools_approval_mode="approve"',
    "-",
  );
  return args;
}

export async function runCodex(input: CodexRunInput): Promise<RunEnvelope> {
  await mkdir(input.artifactsDirectory, { recursive: true });
  const outputFile = path.join(
    input.artifactsDirectory,
    `codex-result-${randomUUID()}.json`,
  );
  const args = buildArguments(input, outputFile);
  const events = codexEventStream(input.onEvent);
  let supervised;
  try {
    supervised = await superviseProcess({
      command: [input.command, ...args],
      cwd: input.workspace,
      env: environment(input.env),
      stdin: input.prompt,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.interruptGraceMs !== undefined ? { interruptGraceMs: input.interruptGraceMs } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      onStdoutChunk: (chunk) => events.parser.write(chunk),
    });
  } catch (error) {
    if (error instanceof HarnessError) {
      throw new CodexRunnerError(error.message, error.kind, null, "", { cause: error });
    }
    throw error;
  }

  const { invalidLine } = events.parser.end();
  const { stdout: raw, stderr, exitCode, durationMs } = supervised;
  const failureDetail = [stderr.trim(), ...events.errors].filter(Boolean).join("\n");
  if (exitCode !== 0) {
    const kind = codexFailureKind(stderr, raw, events.errors);
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
    sessionId: events.sessionId,
    usage: events.usage,
    cost: result.cost ?? { ...UNAVAILABLE_COST },
    durationMs,
    exitCode,
    artifacts: result.artifacts,
    stderr,
  };
}
