import { CodexRunnerError, type CodexMcpConfiguration } from "./codex";
import { superviseProcess } from "./process";
import { HarnessError } from "./harness-error";
import { codexEventStream, codexFailureKind } from "./codex-events";
import type { RunEnvelope } from "./result";

export interface CodexSteeringInput {
  command: string;
  workspace: string;
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
}

export interface CodexSteeringResult {
  summary: string;
  sessionId: string | null;
  usage: RunEnvelope["usage"];
  durationMs: number;
  exitCode: number;
  stderr: string;
}

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
  args.push("-");
  return args;
}

export async function runCodexSteering(
  input: CodexSteeringInput,
): Promise<CodexSteeringResult> {
  let summary = "";
  const events = codexEventStream((event) => {
    input.onEvent?.(event);
    const codexEvent = event as { type?: string; item?: { type?: string; text?: string } };
    if (codexEvent.type === "item.completed" && codexEvent.item?.type === "agent_message" && codexEvent.item.text) {
      summary = codexEvent.item.text;
    }
  });
  let supervised;
  try {
    supervised = await superviseProcess({
      command: [input.command, ...argumentsFor(input)],
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
      throw new CodexRunnerError(error.message, error.kind, null, error.stderr, { cause: error });
    }
    throw error;
  }

  const { invalidLine } = events.parser.end();
  const { stdout: raw, stderr, exitCode, durationMs } = supervised;
  const detail = [stderr.trim(), ...events.errors].filter(Boolean).join("\n");
  if (exitCode !== 0) {
    const kind = codexFailureKind(stderr, raw, events.errors);
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
    sessionId: events.sessionId,
    usage: events.usage,
    durationMs,
    exitCode,
    stderr,
  };
}
