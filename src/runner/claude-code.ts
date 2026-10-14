// Claude Code as an agent runner: `claude -p --output-format stream-json` with the scoped Conveyor
// MCP server, structured output validated against the producer result schema, and session resume.
//
// The process runs inside bubblewrap with the whole filesystem mounted read-only, a private /tmp,
// writable binds for just its own config directory and the run's sanitized home, empty mounts over
// the service's secrets, and /dev/null over the Docker and session-bus sockets. A workspace-write
// agent also gets writable binds for its worktree, the worktree's git metadata and its configured
// roots (package caches). Claude's own permission layer is a second lock: a read-only agent gets
// read tools, Bash and its MCP tools; a workspace-write agent also gets Edit and Write in
// acceptEdits mode, which accepts edits inside the worktree and refuses the rest.

import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { resolveFilesystemPath, resolvePathEnvironment } from "../core/paths";
import { prepareAgentEnvironment } from "../isolation/environment";
import { acquireScratch, assertNoHostTmpWritableRoots } from "../isolation/scratch";
import { log } from "../log/logger";
import { EMPTY_USAGE, UNAVAILABLE_COST, producerResultSchema, type Artifact, type RunEnvelope } from "./result";
import type { HarnessRunInput } from "../harness/types";
import { OUTPUT_SCHEMAS } from "./output-schemas";

export interface ClaudeCodeRunInput extends HarnessRunInput {
  /** Continue this session with `--resume` instead of starting a new one. */
  resumeSessionId?: string;
}

export type ClaudeCodeErrorKind = "usage-limit" | "process" | "protocol" | "timeout" | "interrupted";

export class ClaudeCodeRunnerError extends Error {
  override readonly name = "ClaudeCodeRunnerError";
  /** A non-fatal teardown failure that occurred after the Claude Code process stopped. */
  cleanupError?: string;

  constructor(
    message: string,
    readonly kind: ClaudeCodeErrorKind,
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

interface ClaudeEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
}

const USAGE_LIMIT_PATTERN = /usage limit|rate limit|limit reached|too many requests|\b429\b|quota|overloaded/i;
/** The built-in tools a read-only agent gets; edits and writes are not among them. */
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "Bash"];
/** File tools for a workspace-write agent. Never pre-allowed: acceptEdits scopes them to the worktree. */
const EDIT_TOOLS = ["Edit", "Write"];
const WEB_TOOLS = ["WebFetch", "WebSearch"];
/** Sockets that would hand a command more than the sandbox grants (Docker is root-equivalent). */
const HIDDEN_SOCKETS = ["/run/docker.sock", "/var/run/docker.sock", "/run/containerd/containerd.sock", "/run/dbus/system_bus_socket"];
/** Paths a run must never see, hidden behind empty mounts (relative to the service user's home). */
const HIDDEN = [".config/conveyor-v2", ".config/gh", ".ssh", ".codex", ".gnupg", ".aws"];

async function consumeJsonLines(stream: ReadableStream<Uint8Array>, onEvent: (event: ClaudeEvent) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let raw = "";
  let invalidLine: string | null = null;
  const consume = (line: string): void => {
    if (line.trim().length === 0) return;
    try {
      onEvent(JSON.parse(line) as ClaudeEvent);
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

/** The result schema as Claude Code accepts it: it rejects the `$schema` meta-schema reference. */
export function claudeSchema(raw: string): string {
  const { $schema: _metaSchema, ...schema } = JSON.parse(raw) as Record<string, unknown>;
  return JSON.stringify(schema);
}

/** The `claude` arguments for one run. */
export function claudeArguments(input: ClaudeCodeRunInput, schema: string): string[] {
  const writes = input.sandbox === "workspace-write";
  const web = input.network ? WEB_TOOLS : [];
  const servers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {
    conveyor: { command: input.mcp.command, args: input.mcp.args },
  };
  const serverTools: string[] = [];
  for (const [name, server] of Object.entries(input.mcpServers ?? {})) {
    servers[name] = { command: server.command, args: server.args, ...(Object.keys(server.env).length > 0 ? { env: resolvePathEnvironment(server.env) } : {}) };
    serverTools.push(...(server.enabledTools ? server.enabledTools.map((tool) => `mcp__${name}__${tool}`) : [`mcp__${name}`]));
  }
  const args = [
    "-p", "--output-format", "stream-json", "--verbose",
    // No user, project or local settings: no personal hooks, plugins or permission rules leak in.
    "--setting-sources", "",
    "--strict-mcp-config",
    "--mcp-config", JSON.stringify({ mcpServers: servers }),
    "--tools", [...READ_ONLY_TOOLS, ...(writes ? EDIT_TOOLS : []), ...web].join(","),
    "--allowedTools", [...READ_ONLY_TOOLS, ...web, "mcp__conveyor", ...serverTools].join(","),
    // acceptEdits accepts edits inside the working directory only; anything else would need a prompt, so it is refused.
    "--permission-mode", writes ? "acceptEdits" : "dontAsk",
    "--json-schema", schema,
  ];
  if (input.model) args.push("--model", input.model);
  // Claude Code has no "ultra"; the strongest it offers is "max".
  if (input.effort) args.push("--effort", input.effort === "ultra" ? "max" : input.effort);
  if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
  return args;
}

/** bubblewrap: everything read-only, private /tmp, writable config dir and home, secrets hidden. */
export function sandboxArguments(options: {
  workspace: string; configDir: string; home: string; serviceHome: string | undefined;
  /** Extra writable directories (a workspace-write agent's worktree, git metadata and roots). */
  writable?: readonly string[];
  /** The session bus of the service user, hidden too; resolved from the uid when absent. */
  sessionBus?: string;
}): string[] {
  const workspace = resolveFilesystemPath(options.workspace);
  const configDir = resolveFilesystemPath(options.configDir);
  const home = resolveFilesystemPath(options.home);
  const serviceHome = options.serviceHome ? resolveFilesystemPath(options.serviceHome) : undefined;
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", resolveFilesystemPath("/tmp")];
  if (serviceHome) {
    for (const relative of HIDDEN) {
      const hidden = path.join(serviceHome, relative);
      if (existsSync(hidden)) args.push("--tmpfs", resolveFilesystemPath(hidden));
    }
  }
  const bus = options.sessionBus ?? (typeof process.getuid === "function" ? `/run/user/${process.getuid()}/bus` : null);
  // Resolved first: /var/run is a symlink to /run, and bwrap binds a real path once.
  const sockets = new Set([...HIDDEN_SOCKETS, ...(bus ? [bus] : [])].filter((socket) => existsSync(socket)).map(resolveFilesystemPath));
  for (const socket of sockets) args.push("--ro-bind", "/dev/null", socket);
  for (const directory of options.writable ?? []) {
    if (existsSync(directory)) {
      const resolved = resolveFilesystemPath(directory);
      args.push("--bind", resolved, resolved);
    }
  }
  args.push("--bind", configDir, configDir);
  const legacyConfig = `${configDir}.json`;
  if (existsSync(legacyConfig)) {
    const resolved = resolveFilesystemPath(legacyConfig);
    args.push("--bind", resolved, resolved);
  }
  args.push("--bind", home, home, "--chdir", workspace, "--die-with-parent", "--");
  return args;
}

function isInside(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Moves declared files out of private home so teardown cannot leave dangling artifact references. */
export async function preserveClaudeCodeHomeArtifacts(artifactsDirectory: string, home: string, declared: Artifact[]): Promise<Artifact[]> {
  if (declared.length === 0) return declared;
  const artifacts = resolveFilesystemPath(artifactsDirectory);
  const privateHome = resolveFilesystemPath(home);
  if (!isInside(artifacts, privateHome)) {
    throw new Error(`private home ${privateHome} is outside run artifacts ${artifacts}`);
  }
  const moved = new Map<string, string>();
  const preserved: Artifact[] = [];
  for (const [index, artifact] of declared.entries()) {
    if (!existsSync(artifact.path)) {
      preserved.push(artifact);
      continue;
    }
    const source = resolveFilesystemPath(artifact.path);
    if (!isInside(privateHome, source)) {
      preserved.push(artifact);
      continue;
    }
    let destination = moved.get(source);
    if (!destination) {
      destination = path.join(artifacts, "declared", `${index}-${path.basename(source)}`);
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(source, destination);
      moved.set(source, destination);
    }
    preserved.push({ ...artifact, path: destination });
  }
  return preserved;
}

/** Removes a finished run's resolved private home, never a sibling artifact or an escaped link target. */
export async function clearClaudeCodeHome(artifactsDirectory: string, home: string): Promise<void> {
  const artifacts = resolveFilesystemPath(artifactsDirectory);
  const privateHome = resolveFilesystemPath(home);
  if (!isInside(artifacts, privateHome)) {
    throw new Error(`private home ${privateHome} is outside run artifacts ${artifacts}`);
  }
  await rm(privateHome, { recursive: true, force: true });
}

export async function runClaudeCode(input: ClaudeCodeRunInput): Promise<RunEnvelope> {
  if (input.sandbox === "danger-full-access") {
    throw new ClaudeCodeRunnerError("Claude Code agents run read-only or workspace-write, never with full access", "process", null, "");
  }
  if (input.egress) {
    throw new ClaudeCodeRunnerError("Claude Code agents do not support network egress isolation yet", "process", null, "");
  }
  await mkdir(input.artifactsDirectory, { recursive: true });
  const artifactsDirectory = resolveFilesystemPath(input.artifactsDirectory);
  const workspace = resolveFilesystemPath(input.workspace);
  assertNoHostTmpWritableRoots(input.writableRoots);
  const writableRoots = (input.writableRoots ?? []).filter(existsSync).map(resolveFilesystemPath);
  const scratch = await acquireScratch(input.temporaryDirectory);
  const startedAt = performance.now();
  let privateHome: string | undefined;
  let privateHomeClearAttempted = false;
  const clearPrivateHome = async (): Promise<string | undefined> => {
    if (!privateHome || privateHomeClearAttempted) return undefined;
    privateHomeClearAttempted = true;
    try {
      await clearClaudeCodeHome(artifactsDirectory, privateHome);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const cleanupError = `could not clear Claude Code private home after the process stopped: ${detail}`;
      log.error("Claude Code run cleanup failed", { artifactsDirectory, cleanupError });
      return cleanupError;
    }
    return undefined;
  };
  try {
    const environment = await prepareAgentEnvironment({
      artifactsDirectory, workspace, overrides: input.env,
      controlPlane: ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    });
    // prepareAgentEnvironment creates this home before config setup, so record it for early-failure teardown.
    const preparedHome = resolveFilesystemPath(environment.HOME!);
    privateHome = preparedHome;
    const serviceHome = process.env.HOME ? resolveFilesystemPath(process.env.HOME) : undefined;
    const configDir = environment.CLAUDE_CONFIG_DIR ?? (serviceHome ? path.join(serviceHome, ".claude") : undefined);
    if (!configDir) {
      throw new ClaudeCodeRunnerError("cannot locate the Claude Code config directory: set CLAUDE_CONFIG_DIR or HOME", "process", null, "");
    }
    await mkdir(configDir, { recursive: true });
    environment.CLAUDE_CONFIG_DIR = resolveFilesystemPath(configDir);
    environment.TMPDIR = scratch.path;
    const resolvedEnvironment = resolvePathEnvironment(environment);
    const schema = claudeSchema(OUTPUT_SCHEMAS.producer);
    const argv = [
      "bwrap", ...sandboxArguments({
        workspace, configDir: resolvedEnvironment.CLAUDE_CONFIG_DIR!, home: resolvedEnvironment.HOME!, serviceHome,
        // Claude itself needs private temporary storage even when its workspace is read-only.
        writable: [
          ...(input.sandbox === "workspace-write" ? [workspace, ...writableRoots] : []),
          scratch.path,
        ],
      }),
      input.command, ...claudeArguments(input, schema),
    ];
    const child = Bun.spawn(argv, { cwd: workspace, env: resolvedEnvironment, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(input.prompt);
    child.stdin.end();

    let sessionId: string | null = null;
    let result: ClaudeEvent | null = null;
    const stdoutPromise = consumeJsonLines(child.stdout, (event) => {
      input.onEvent?.(event);
      if (event.session_id) sessionId = event.session_id;
      if (event.type === "result") result = event;
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
    try {
      exitCode = await child.exited;
    } finally {
      await scratch.cleanup();
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal?.removeEventListener("abort", onAbort);
    }
    const [{ raw, invalidLine }, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    const final = result as ClaudeEvent | null;
    const detail = [stderr.trim(), final?.is_error ? final.result ?? "" : ""].filter(Boolean).join("\n");

    if (timedOut) throw new ClaudeCodeRunnerError(`Claude Code timed out after ${input.timeoutMs}ms${detail ? `: ${detail}` : ""}`, "timeout", exitCode, stderr);
    if (interrupted) throw new ClaudeCodeRunnerError(`Claude Code was interrupted${detail ? `: ${detail}` : ""}`, "interrupted", exitCode, stderr);
    if (exitCode !== 0 || final?.is_error) {
      const kind = USAGE_LIMIT_PATTERN.test(`${detail}\n${raw.slice(-4_000)}`) ? "usage-limit" : "process";
      throw new ClaudeCodeRunnerError(`Claude Code exited with code ${exitCode}${detail ? `: ${detail}` : ""}`, kind, exitCode, stderr);
    }
    if (invalidLine) throw new ClaudeCodeRunnerError(`Claude Code emitted invalid JSONL: ${invalidLine}`, "protocol", exitCode, stderr);
    if (!final) throw new ClaudeCodeRunnerError("Claude Code finished without a result event", "protocol", exitCode, stderr);

    const parsed = producerResultSchema.safeParse(final.structured_output);
    if (!parsed.success) {
      throw new ClaudeCodeRunnerError(
        `Claude Code structured output failed validation: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "result"}: ${issue.message}`).join("; ")}`,
        "protocol", exitCode, stderr,
      );
    }
    const usage = { ...EMPTY_USAGE };
    const reported = final.usage ?? {};
    // Input counts everything sent, as Codex reports it; cached is the part served from the prompt cache.
    usage.cachedTokens = reported.cache_read_input_tokens ?? 0;
    usage.inputTokens = (reported.input_tokens ?? 0) + (reported.cache_creation_input_tokens ?? 0) + usage.cachedTokens;
    usage.outputTokens = reported.output_tokens ?? 0;
    const value = parsed.data;
    const artifacts = await preserveClaudeCodeHomeArtifacts(artifactsDirectory, preparedHome, value.artifacts);
    const cleanupError = await clearPrivateHome();
    return {
      stageResult: { outcome: value.outcome, status: value.status, summary: value.summary, reason: value.reason, metrics: value.metrics },
      sessionId,
      usage,
      cost: { ...UNAVAILABLE_COST },
      durationMs,
      exitCode,
      artifacts,
      stderr,
      ...(cleanupError ? { cleanupError } : {}),
    };
  } catch (error) {
    await scratch.cleanup();
    const cleanupError = await clearPrivateHome();
    throw withCleanupError(error, cleanupError);
  }
}
