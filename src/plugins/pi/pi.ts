// pi as an agent runner: `pi --mode json` with only what Conveyor chooses (no extensions but its MCP
// support, no skills, prompt templates or themes, no project-local configuration), the run-scoped
// Conveyor MCP server declared directly, its final message validated as the producer result, and
// session resume.
//
// pi has no sandbox of its own: the process runs inside the shared empty-root filesystem mount plan,
// which is the only boundary. A workspace-write agent gets writable mounts for its worktree, Git
// metadata and configured roots; pi's tool list is a second lock: a read-only agent gets read tools,
// bash and its MCP tools, and a workspace-write agent also gets edit and write.
//
// Under agentEgress the process runs in the run's network namespace (see launch.ts): pi reaches its
// model through the control-plane proxy, while its commands and MCP servers get the data-plane proxy.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { resolveFilesystemPath, resolvePathEnvironment } from "../../core/paths";
import { cleanupSanitizedHome, prepareAgentEnvironment } from "../../isolation/environment";
import { defaultRunVariables } from "../../isolation/run-environment";
import { agentFilesystemCommand, verifyAgentWrapper, type AgentFilesystemOptions } from "../../isolation/sandbox";
import { acquireScratch, assertNoHostTmpWritableRoots, type ScratchDirectory } from "../../isolation/scratch";
import type { RunNetwork } from "../../isolation/run-network";
import { log } from "../../log/logger";
import type { HarnessRunInput } from "../../harness/types";
import { OUTPUT_SCHEMAS } from "../../runner/output-schemas";
import { EMPTY_USAGE, UNAVAILABLE_COST, producerResultSchema, type RunEnvelope } from "../../runner/result";
import { sandboxSetupError } from "../../runner/sandbox-failure";
import { PI_AGENT_DIRECTORY, preparePiAgentDirectory, servicePiAgentDirectory, syncPiAgentDirectory } from "./agent-directory";
import { piRunnerSchema, type PiRunnerConfig } from "./config";
import { PI_MCP_LAUNCH, piCommandEnvironmentFile, piControlPlaneHosts, piInstallation, piLaunch, piMountRoot, piShellCommandPrefix } from "./launch";
import { piProfile } from "./profile";

export interface PiRunInput extends HarnessRunInput {
  /** Continue this session with `--session` instead of starting a new one. */
  resumeSessionId?: string;
}

export type PiErrorKind = "usage-limit" | "sandbox" | "process" | "protocol" | "invalid-result" | "timeout" | "interrupted";

export class PiRunnerError extends Error {
  override readonly name = "PiRunnerError";
  /** A non-fatal teardown failure that occurred after the pi process stopped. */
  cleanupError?: string;
  /** The session that produced an invalid result, so the same session can be asked to correct it. */
  sessionId?: string;

  constructor(
    message: string,
    readonly kind: PiErrorKind,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** Keeps the primary run failure intact while exposing a secondary teardown failure. */
function withCleanupError<T>(error: T, cleanupError: string | undefined): T {
  if (!cleanupError || !error || (typeof error !== "object" && typeof error !== "function")) return error;
  try {
    Object.assign(error as object, { cleanupError });
  } catch {
    // A frozen third-party error still has its cleanup failure recorded in the service log.
  }
  return error;
}

interface PiUsage { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
interface PiMessage { role?: string; content?: unknown; stopReason?: string; errorMessage?: string; usage?: PiUsage }
interface PiEvent {
  type?: string;
  id?: string;
  message?: PiMessage;
  success?: boolean;
  finalError?: string;
  aborted?: boolean;
  toolName?: string;
  isError?: boolean;
  result?: { content?: unknown };
}

/**
 * Usage and rate limits, from pi's own provider error wording (its non-retryable limit errors, and
 * the retry delay a provider asked for beyond pi's limit) and the providers' common phrases.
 */
const USAGE_LIMIT_PATTERN = /usage limit|rate.?limit|limit reached|too many requests|\b429\b|quota|overloaded|available balance|out of budget|billing|ResourceExhausted|retry delay/i;
/** The built-in tools a read-only agent gets; edits and writes are not among them. */
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const EDIT_TOOLS = ["edit", "write"];
/** Stream records that only carry deltas of a message or tool output; the completed record follows. */
const DELTA_EVENTS = new Set(["message_update", "tool_execution_update"]);

/** pi's name for an MCP server or tool: every character other than letters, digits and `_` becomes `_`. */
const mcpName = (value: string): string => value.replace(/[^A-Za-z0-9_]/g, "_");

/** The tools pi declares to the agent: its access decides the built-ins, and MCP tools are only Conveyor's and its servers'. */
export function piTools(input: Pick<PiRunInput, "sandbox" | "shell" | "mcpServers">): string[] {
  const builtIn = [...READ_ONLY_TOOLS, ...(input.shell === false ? [] : ["bash"]), ...(input.sandbox === "workspace-write" ? EDIT_TOOLS : [])];
  // Once one entry starts with `mcp__`, `--tools` filters MCP tools too, so every allowed one is named.
  const servers = Object.entries(input.mcpServers ?? {}).flatMap(([name, server]) =>
    server.enabledTools ? server.enabledTools.map((tool) => `mcp__${mcpName(name)}__${mcpName(tool)}`) : [`mcp__${mcpName(name)}__*`]);
  return [...builtIn, "mcp__conveyor__*", ...servers];
}

/**
 * The run's `mcp.json`: Conveyor's scoped server and the agent's servers, all declared directly to the
 * model (an agent server's `enabledTools` are the only ones not hidden).
 */
export function piMcpConfiguration(
  input: Pick<PiRunInput, "mcp" | "mcpServers">,
  egress?: { shell: string; commandEnvironment: string },
): Record<string, unknown> {
  // pi starts a server with its own environment (no shell), so under egress the server is started
  // through the shell, which first sources the command environment its bash commands get.
  const launch = (command: string, args: string[]) => egress
    ? { command: egress.shell, args: ["-c", PI_MCP_LAUNCH, egress.commandEnvironment, command, ...args] }
    : { command, args };
  const servers: Record<string, Record<string, unknown>> = {
    conveyor: { ...launch(input.mcp.command, input.mcp.args), exposure: "direct" },
  };
  for (const [name, server] of Object.entries(input.mcpServers ?? {})) {
    const env = resolvePathEnvironment(server.env);
    // pi expands `${NAME}` in env values and runs a value starting with `!` as a command.
    const expanded = Object.entries(env).find(([, value]) => value.startsWith("!") || value.includes("${"));
    if (expanded) {
      throw new PiRunnerError(`MCP server ${name}: pi would expand the value of ${expanded[0]} (it starts with "!" or contains "\${"); use a literal value`, "process", null, "");
    }
    servers[name] = {
      ...launch(server.command, server.args),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(server.enabledTools
        ? { exposure: "hidden", toolExposure: Object.fromEntries(server.enabledTools.map((tool) => [tool, "direct"])) }
        : { exposure: "direct" }),
    };
  }
  // No server needs codemode; keep pi from turning it on.
  return { autoEnableCodemode: false, mcpServers: servers };
}

/** The variables the pi process holds for itself, which its commands never get: its agent directory and the run's `programVariables`. */
export function piProcessVariables(programVariables: readonly string[]): string[] {
  return [...new Set([PI_AGENT_DIRECTORY, ...programVariables])];
}

/** The pi process's own variables: the harness level's environment and the deprecated `credentialVariables`. */
function piProgramVariables(input: { programVariables?: readonly string[] | undefined }, runner: { credentialVariables: readonly string[] }): string[] {
  return [...new Set([...(input.programVariables ?? []), ...runner.credentialVariables])];
}

/** The deprecated `credentialVariables`, with their values from the service. */
function credentialValues(names: readonly string[], service: Record<string, string | undefined> = process.env): Record<string, string> {
  return Object.fromEntries(names.flatMap((name) => (service[name] === undefined ? [] : [[name, service[name]!]])));
}

/** The run's `settings.json`: Conveyor's choices only, never the operator's own settings. */
export function piSettings(options: {
  shell: string;
  /** What commands may not inherit besides pi's agent directory: the run's `programVariables`. */
  programVariables: readonly string[];
  provider?: string | undefined;
  /** Under egress: the command environment file every command sources first. */
  commandEnvironment?: string | undefined;
}): Record<string, unknown> {
  return {
    shellPath: options.shell,
    // Every command starts by dropping what the pi process holds for itself (and, under egress, by taking the data-plane proxy).
    shellCommandPrefix: piShellCommandPrefix({ unset: piProcessVariables(options.programVariables), commandEnvironment: options.commandEnvironment }),
    defaultProjectTrust: "never",
    enableInstallTelemetry: false,
    ...(options.provider ? { defaultProvider: options.provider } : {}),
  };
}

/** Tells pi how to return the run's result: pi has no structured-output option, so the final message is the result. */
export function piResultInstructions(schema: string): string {
  return [
    "Conveyor reads your final message as the result of this run.",
    "When the work is done, your final message must be exactly one JSON object that matches the JSON Schema below:",
    "no other text before or after it, and no Markdown code fence.",
    "",
    schema,
  ].join("\n");
}

/** The `pi` arguments for one run. */
export function piArguments(
  input: Pick<PiRunInput, "sandbox" | "shell" | "mcpServers" | "model" | "effort">,
  options: { sessions: string; resumeFile?: string | undefined; provider?: string | undefined; schema: string },
): string[] {
  const args = [
    "--mode", "json",
    // Project-local configuration (.pi/settings.json, .pi/mcp.json, extensions) is never trusted.
    "--no-approve",
    // Only pi's built-in MCP support: no discovered, configured or other built-in extensions.
    "--no-extensions", "-e", "builtin:mcp",
    "--no-skills", "--no-prompt-templates", "--no-themes",
    // Always explicit: a project's sessionDir setting is read before project trust is decided.
    "--session-dir", options.sessions,
    "--tools", piTools(input).join(","),
    "--append-system-prompt", piResultInstructions(options.schema),
  ];
  if (input.model) {
    if (options.provider) args.push("--provider", options.provider);
    args.push("--model", input.model);
  }
  // pi has no "ultra"; the strongest it offers is "max".
  if (input.effort) args.push("--thinking", input.effort === "ultra" ? "max" : input.effort);
  if (options.resumeFile) args.push("--session", options.resumeFile);
  return args;
}

/** The result in pi's final message: one JSON value, optionally inside a single ```json fence. */
export function parsePiResult(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  return JSON.parse(fenced ? fenced[1]! : trimmed) as unknown;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: unknown; text?: unknown }>)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

/** Reads pi's JSONL records, split only on LF as its protocol requires. */
async function consumeJsonLines(stream: ReadableStream<Uint8Array>, onEvent: (event: PiEvent) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let invalidLine: string | null = null;
  const consume = (line: string): void => {
    const record = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (record.trim().length === 0) return;
    let event: unknown;
    try {
      event = JSON.parse(record);
    } catch {
      invalidLine ??= record;
      return;
    }
    if (event && typeof event === "object" && !Array.isArray(event)) onEvent(event as PiEvent);
    else invalidLine ??= record;
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consume(line);
  }
  consume(buffer + decoder.decode());
  return { invalidLine };
}

function runnerSettings(input: PiRunInput): PiRunnerConfig {
  // The core completes every harness entry with its `settings` (environment and harness keys); pi's own schema reads the rest.
  const { environment: _environment, settings: _settings, ...runner } = input.runner ?? { type: "pi", command: input.command };
  const parsed = piRunnerSchema.safeParse(runner);
  if (!parsed.success) {
    throw new PiRunnerError(`the run's runner is not a valid pi runner: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "runner"}: ${issue.message}`).join("; ")}`, "process", null, "");
  }
  return parsed.data;
}

/** Completes every resource cleanup, retaining failures for the run's result or log. */
async function cleanupPiRun(options: {
  artifactsDirectory: string;
  scratch: Pick<ScratchDirectory, "cleanup">;
  home: string | undefined;
  serviceDirectory: string | undefined;
}): Promise<string | undefined> {
  const failures: string[] = [];
  for (const [name, cleanup] of [
    ["scratch", () => options.scratch.cleanup()],
    ["pi agent directory", () => options.home && options.serviceDirectory
      ? syncPiAgentDirectory({ home: options.home, serviceDirectory: options.serviceDirectory })
      : undefined],
    ["private home", () => cleanupSanitizedHome(options.artifactsDirectory)],
  ] as const) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!failures.length) return undefined;
  const cleanupError = failures.join("; ");
  log.error("pi run cleanup failed", { artifactsDirectory: options.artifactsDirectory, cleanupError });
  return cleanupError;
}

export async function runPi(input: PiRunInput): Promise<RunEnvelope> {
  if (input.sandbox === "danger-full-access") {
    throw new PiRunnerError("pi agents run read-only or workspace-write, never with full access", "process", null, "");
  }
  const runner = runnerSettings(input);
  const controlPlaneHosts = input.egress ? input.egress.controlPlaneHosts ?? piControlPlaneHosts(runner) : [];
  if (input.egress && controlPlaneHosts.length === 0) {
    // Configuration loading refuses this first; without hosts pi could never reach its model.
    throw new PiRunnerError(`the pi runner names no controlPlaneHosts and pi has no default hosts for its provider${runner.provider ? ` ${runner.provider}` : ""}, so its agent was not started under agentEgress`, "process", null, "");
  }
  await mkdir(input.artifactsDirectory, { recursive: true });
  const artifactsDirectory = resolveFilesystemPath(input.artifactsDirectory);
  const workspace = resolveFilesystemPath(input.workspace);
  assertNoHostTmpWritableRoots(input.writableRoots);
  const writableRoots = (input.writableRoots ?? []).filter(existsSync).map(resolveFilesystemPath);
  const scratch = await acquireScratch(input.temporaryDirectory);
  const startedAt = performance.now();
  let home: string | undefined;
  let serviceDirectory: string | undefined;
  let network: RunNetwork | null = null;
  let cleaned = false;
  const cleanup = async (): Promise<string | undefined> => {
    if (cleaned) return undefined;
    cleaned = true;
    await network?.close();
    return cleanupPiRun({ artifactsDirectory, scratch, home, serviceDirectory });
  };
  try {
    const programVariables = piProgramVariables(input, runner);
    const environment = await prepareAgentEnvironment({
      artifactsDirectory, workspace,
      variables: { ...(input.env ?? defaultRunVariables()), ...credentialValues(runner.credentialVariables) },
    });
    home = resolveFilesystemPath(environment.HOME!);
    serviceDirectory = resolveFilesystemPath(servicePiAgentDirectory(input.env));
    const commandEnvironment = input.egress ? piCommandEnvironmentFile(artifactsDirectory) : undefined;
    // The service's agent directory is never mounted: the run gets a private copy inside its home.
    const agentDirectory = await preparePiAgentDirectory({
      home,
      serviceDirectory,
      settings: piSettings({ shell: environment.SHELL!, programVariables, provider: runner.provider, commandEnvironment }),
      mcp: piMcpConfiguration(input, commandEnvironment ? { shell: environment.SHELL!, commandEnvironment } : undefined),
      resumeSessionId: input.resumeSessionId,
    });
    environment[PI_AGENT_DIRECTORY] = agentDirectory.directory;
    environment.PI_SKIP_VERSION_CHECK = "1";
    environment.TMPDIR = scratch.path;
    const resolvedEnvironment = resolvePathEnvironment(environment);
    // The installer's Node is found in the service's data directory, which the run's environment no longer names.
    const installation = piInstallation(input.command, resolvedEnvironment, { ...process.env, ...input.env });
    const launched = installation.interpreter
      ? [installation.interpreter.path, ...installation.interpreter.args, installation.executable]
      : [installation.executable];
    const filesystemOptions: AgentFilesystemOptions = {
      // The resolved program, never the command's own path: an installer's launcher stays outside the sandbox.
      command: launched[0]!,
      env: resolvedEnvironment,
      workspace,
      artifacts: artifactsDirectory,
      home,
      scratch: scratch.path,
      writableGit: input.sandbox === "workspace-write",
      writable: input.sandbox === "workspace-write" ? [workspace, ...writableRoots] : [],
      runtime: [
        piMountRoot(installation),
        ...(installation.interpreter ? [installation.interpreter.path] : []),
        input.mcp.command,
        ...Object.values(input.mcpServers ?? {}).map((server) => server.command),
      ],
      ...(input.toolchainPaths?.length ? { toolchain: input.toolchainPaths } : {}),
    };
    const argv = [
      ...launched,
      ...piArguments(input, { sessions: agentDirectory.sessions, resumeFile: agentDirectory.resumeFile, provider: runner.provider, schema: OUTPUT_SCHEMAS.producer }),
    ];
    let launch: { argv: string[]; env: Record<string, string> };
    if (input.egress) {
      // Fails closed: without the namespace and its proxies pi is never started.
      const egressLaunch = await piLaunch({
        environment: resolvedEnvironment, artifactsDirectory, egress: input.egress, controlPlaneHosts,
        filesystem: filesystemOptions, argv, unset: piProcessVariables(programVariables),
      });
      network = egressLaunch.network;
      launch = egressLaunch;
    } else {
      launch = agentFilesystemCommand(filesystemOptions, argv);
      verifyAgentWrapper(launch, launched[0]);
    }
    const child = Bun.spawn(launch.argv, { cwd: workspace, env: launch.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    // Release the per-run network whenever the process ends, even if later handling throws.
    void child.exited.finally(() => network?.close());
    child.stdin.write(input.prompt);
    child.stdin.end();

    let sessionId: string | null = null;
    let final: PiMessage | null = null;
    let retryFailure: string | null = null;
    let settledAborted = false;
    let sandboxError: string | null = null;
    const reported = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const stdoutPromise = consumeJsonLines(child.stdout, (event) => {
      if (!DELTA_EVENTS.has(event.type ?? "")) input.onEvent?.(event);
      if (event.type === "session" && typeof event.id === "string") sessionId = event.id;
      if (event.type === "message_end" && event.message?.role === "assistant") {
        final = event.message;
        for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
          const value = event.message.usage?.[key];
          if (typeof value === "number" && Number.isFinite(value) && value > 0) reported[key] += Math.round(value);
        }
      }
      if (event.type === "auto_retry_end" && event.success === false) retryFailure = event.finalError || "pi stopped retrying the model request";
      if (event.type === "agent_settled" && event.aborted === true) settledAborted = true;
      if (event.type === "tool_execution_end" && event.toolName === "bash" && event.isError === true) {
        sandboxError ??= sandboxSetupError(messageText(event.result?.content));
      }
    });
    const stderrPromise = new Response(child.stderr).text();

    let timedOut = false;
    let interrupted = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), input.interruptGraceMs ?? 10_000);
    };
    const timeoutTimer = input.timeoutMs ? setTimeout(() => { timedOut = true; stop(); }, input.timeoutMs) : undefined;
    const onAbort = (): void => { interrupted = true; stop(); };
    input.signal?.addEventListener("abort", onAbort, { once: true });

    let exitCode: number;
    let cleanupError: string | undefined;
    try {
      exitCode = await child.exited;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal?.removeEventListener("abort", onAbort);
      cleanupError = await cleanup();
    }
    const [{ invalidLine }, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    const last = final as PiMessage | null;
    const failedResponse = last?.stopReason === "error" || last?.stopReason === "aborted";
    const responseError = retryFailure ?? (failedResponse ? last?.errorMessage || `the model response was ${last?.stopReason}` : null)
      ?? (settledAborted ? "the run was aborted" : null);
    const detail = [stderr.trim(), responseError ?? ""].filter(Boolean).join("\n");
    const failure = (message: string, kind: PiErrorKind) => withCleanupError(new PiRunnerError(message, kind, exitCode, stderr), cleanupError);

    if (timedOut) throw failure(`pi timed out after ${input.timeoutMs}ms${detail ? `: ${detail}` : ""}`, "timeout");
    if (interrupted) throw failure(`pi was interrupted${detail ? `: ${detail}` : ""}`, "interrupted");
    if (sandboxError) throw failure(`pi sandbox could not start commands: ${sandboxError}`, "sandbox");
    if (exitCode !== 0 || responseError) {
      // pi exits 0 in JSON mode even when the model request failed, so the response decides too.
      const kind = USAGE_LIMIT_PATTERN.test(detail) ? "usage-limit" : "process";
      throw failure(exitCode !== 0 ? `pi exited with code ${exitCode}${detail ? `: ${detail}` : ""}` : `pi's model request failed: ${detail}`, kind);
    }
    if (invalidLine) throw failure(`pi emitted invalid JSONL: ${invalidLine}`, "protocol");
    if (!sessionId) throw failure("pi finished without a session header", "protocol");

    const invalid = (message: string) => Object.assign(failure(message, "invalid-result"), { sessionId: sessionId ?? undefined });
    const text = last ? messageText(last.content) : "";
    if (!text.trim()) throw invalid("pi's final message did not contain the result: it must be exactly one JSON object matching the result schema");
    let decoded: unknown;
    try {
      decoded = parsePiResult(text);
    } catch (error) {
      throw invalid(`pi's final message is not a JSON result (${error instanceof Error ? error.message : String(error)}): it must be exactly one JSON object matching the result schema, with no other text`);
    }
    const parsed = producerResultSchema.safeParse(decoded);
    if (!parsed.success) {
      throw invalid(`pi's result failed validation: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "result"}: ${issue.message}`).join("; ")}`);
    }
    const value = parsed.data;
    return {
      stageResult: { outcome: value.outcome, status: value.status, summary: value.summary, reason: value.reason, metrics: value.metrics },
      sessionId,
      // Input counts everything sent, as Codex reports it; cached is the part served from the prompt cache.
      usage: { ...EMPTY_USAGE, inputTokens: reported.input + reported.cacheRead + reported.cacheWrite, cachedTokens: reported.cacheRead, outputTokens: reported.output },
      cost: { ...UNAVAILABLE_COST },
      durationMs,
      exitCode,
      artifacts: value.artifacts,
      stderr,
      ...(cleanupError ? { cleanupError } : {}),
    };
  } catch (error) {
    throw withCleanupError(error, await cleanup());
  }
}
