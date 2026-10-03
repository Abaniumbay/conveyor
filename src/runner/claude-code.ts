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

import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { prepareAgentEnvironment } from "../isolation/environment";
import { EMPTY_USAGE, UNAVAILABLE_COST, producerResultSchema, type RunEnvelope } from "./result";
import type { HarnessRunInput } from "../harness/types";

export interface ClaudeCodeRunInput extends HarnessRunInput {
  /** Continue this session with `--resume` instead of starting a new one. */
  resumeSessionId?: string;
}

export type ClaudeCodeErrorKind = "usage-limit" | "process" | "protocol" | "timeout" | "interrupted";

export class ClaudeCodeRunnerError extends Error {
  override readonly name = "ClaudeCodeRunnerError";

  constructor(
    message: string,
    readonly kind: ClaudeCodeErrorKind,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
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

const OUTPUT_SCHEMA = path.join(import.meta.dir, "schemas/producer-result.json");
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
    servers[name] = { command: server.command, args: server.args, ...(Object.keys(server.env).length > 0 ? { env: server.env } : {}) };
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
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  if (options.serviceHome) {
    for (const relative of HIDDEN) {
      const hidden = path.join(options.serviceHome, relative);
      if (existsSync(hidden)) args.push("--tmpfs", hidden);
    }
  }
  const bus = options.sessionBus ?? (typeof process.getuid === "function" ? `/run/user/${process.getuid()}/bus` : null);
  // Resolved first: /var/run is a symlink to /run, and bwrap binds a real path once.
  const sockets = new Set([...HIDDEN_SOCKETS, ...(bus ? [bus] : [])].filter((socket) => existsSync(socket)).map((socket) => realpathSync(socket)));
  for (const socket of sockets) args.push("--ro-bind", "/dev/null", socket);
  for (const directory of options.writable ?? []) {
    if (existsSync(directory)) args.push("--bind", directory, directory);
  }
  args.push("--bind", options.configDir, options.configDir);
  const legacyConfig = `${options.configDir}.json`;
  if (existsSync(legacyConfig)) args.push("--bind", legacyConfig, legacyConfig);
  args.push("--bind", options.home, options.home, "--chdir", options.workspace, "--die-with-parent", "--");
  return args;
}

export async function runClaudeCode(input: ClaudeCodeRunInput): Promise<RunEnvelope> {
  if (input.sandbox === "danger-full-access") {
    throw new ClaudeCodeRunnerError("Claude Code agents run read-only or workspace-write, never with full access", "process", null, "");
  }
  if (input.egress) {
    throw new ClaudeCodeRunnerError("Claude Code agents do not support network egress isolation yet", "process", null, "");
  }
  await mkdir(input.artifactsDirectory, { recursive: true });
  const startedAt = performance.now();
  const environment = await prepareAgentEnvironment({
    artifactsDirectory: input.artifactsDirectory, workspace: input.workspace, overrides: input.env,
    controlPlane: ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  });
  const serviceHome = process.env.HOME;
  const configDir = environment.CLAUDE_CONFIG_DIR ?? (serviceHome ? path.join(serviceHome, ".claude") : undefined);
  if (!configDir) throw new ClaudeCodeRunnerError("cannot locate the Claude Code config directory: set CLAUDE_CONFIG_DIR or HOME", "process", null, "");
  environment.CLAUDE_CONFIG_DIR = configDir;
  await mkdir(configDir, { recursive: true });
  const schema = claudeSchema(await readFile(OUTPUT_SCHEMA, "utf8"));
  const argv = [
    "bwrap", ...sandboxArguments({
      workspace: input.workspace, configDir, home: environment.HOME!, serviceHome,
      ...(input.sandbox === "workspace-write" ? { writable: [input.workspace, ...(input.writableRoots ?? [])] } : {}),
    }),
    input.command, ...claudeArguments(input, schema),
  ];
  const child = Bun.spawn(argv, { cwd: input.workspace, env: environment, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
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
  return {
    stageResult: { outcome: value.outcome, status: value.status, summary: value.summary, reason: value.reason, metrics: value.metrics },
    sessionId,
    usage,
    cost: { ...UNAVAILABLE_COST },
    durationMs,
    exitCode,
    artifacts: value.artifacts,
    stderr,
  };
}
