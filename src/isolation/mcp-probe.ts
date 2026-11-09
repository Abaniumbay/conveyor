// Starts an agent's MCP server once and asks it to `initialize`, the way the agent's harness would.
// Codex and Claude Code start these servers themselves and carry on without one that fails, so this
// probe is how Conveyor learns which server failed and why.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolvePathEnvironment } from "../core/paths";
import { agentFilesystemCommand } from "./sandbox";

export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  startupTimeoutSec?: number | undefined;
}

export type McpProbeResult =
  | { ok: true }
  | { ok: false; reason: "exited" | "timeout" | "spawn" | "protocol"; detail: string };

/** Codex's own default when a server declares no startup timeout. */
export const DEFAULT_MCP_STARTUP_TIMEOUT_SEC = 10;

const STDERR_TAIL_CHARS = 1_000;

/** Wraps the server command (for example in the agent's filesystem sandbox) before it is spawned. */
export type McpLaunchWrapper = (argv: string[], env: Record<string, string>) => { argv: string[]; env: Record<string, string> };

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL_CHARS ? `…${trimmed.slice(-STDERR_TAIL_CHARS)}` : trimmed;
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "conveyor-probe", version: "1" } },
});

/** True when the line is the JSON-RPC response to our initialize request. */
function answersInitialize(line: string): boolean {
  try {
    const message = JSON.parse(line) as { id?: unknown; result?: unknown };
    return message.id === 1 && message.result !== undefined;
  } catch {
    return false;
  }
}

/** Starts the server, sends `initialize`, and reports whether it answered before its startup timeout. */
export async function probeMcpServer(
  server: McpServerSpec,
  options: { cwd: string; env?: Record<string, string>; wrap?: McpLaunchWrapper } = { cwd: "." },
): Promise<McpProbeResult> {
  const env = resolvePathEnvironment({ ...(options.env ?? {}), ...server.env });
  let launch: { argv: string[]; env: Record<string, string> };
  try {
    launch = options.wrap ? options.wrap([server.command, ...server.args], env) : { argv: [server.command, ...server.args], env };
  } catch (error) {
    return { ok: false, reason: "spawn", detail: error instanceof Error ? error.message : String(error) };
  }
  const timeoutSec = server.startupTimeoutSec ?? DEFAULT_MCP_STARTUP_TIMEOUT_SEC;
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(launch.argv, { cwd: options.cwd, env: launch.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    return { ok: false, reason: "spawn", detail: error instanceof Error ? error.message : String(error) };
  }
  const stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text().catch(() => "");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutSec * 1_000); });
  const answered = (async (): Promise<"answered" | "closed"> => {
    try {
      (child.stdin as import("bun").FileSink).write(`${INITIALIZE}\n`);
      await (child.stdin as import("bun").FileSink).flush();
    } catch {
      // The server already exited; its exit is reported below.
    }
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }));
      if (done) return "closed";
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      if (lines.some(answersInitialize)) return "answered";
    }
  })();
  try {
    const outcome = await Promise.race([answered, timeout]);
    if (outcome === "answered") return { ok: true };
    if (outcome === "timeout") {
      return { ok: false, reason: "timeout", detail: `did not answer initialize within ${timeoutSec}s` };
    }
    const code = await child.exited;
    const text = tail(await stderr);
    return { ok: false, reason: "exited", detail: `exited with status ${code} before answering initialize${text ? `: ${text}` : ""}` };
  } finally {
    if (timer) clearTimeout(timer);
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    await child.exited.catch(() => undefined);
  }
}

export interface McpFailure {
  server: string;
  detail: string;
}

/** Probes every server once and returns the ones that failed, in configuration order. */
export async function probeMcpServers(
  servers: Record<string, McpServerSpec>,
  options: { cwd: string; env?: Record<string, string>; wrap?: McpLaunchWrapper },
): Promise<McpFailure[]> {
  const results = await Promise.all(Object.entries(servers).map(async ([server, spec]) => ({ server, result: await probeMcpServer(spec, options) })));
  return results.flatMap(({ server, result }) => (result.ok ? [] : [{ server, detail: result.detail }]));
}

/**
 * Probes an agent's servers inside the filesystem sandbox the agent itself runs in. `workspace` is the
 * run's worktree (doctor passes a scratch directory); `{workspace}` in server arguments is replaced by it.
 */
export async function probeAgentMcpServers(
  servers: Record<string, McpServerSpec>,
  options: { workspace: string; env?: Record<string, string> },
): Promise<McpFailure[]> {
  if (Object.keys(servers).length === 0) return [];
  const scratchRoot = await mkdtemp(path.join(tmpdir(), "conveyor-mcp-probe-"));
  try {
    const home = path.join(scratchRoot, "home");
    const scratch = path.join(scratchRoot, "scratch");
    await Promise.all([mkdir(home), mkdir(scratch)]);
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: scratch, ...(options.env ?? {}) };
    const wrap: McpLaunchWrapper = (argv, serverEnv) => {
      const merged = { ...env, ...serverEnv };
      const launch = agentFilesystemCommand(
        { command: argv[0]!, env: merged, workspace: options.workspace, artifacts: scratchRoot, home, scratch, writable: [options.workspace], runtime: [argv[0]!] },
        argv,
      );
      return { argv: launch.argv, env: launch.env };
    };
    const resolved = Object.fromEntries(Object.entries(servers).map(([name, server]) => [
      name,
      { ...server, args: server.args.map((arg) => arg.replaceAll("{workspace}", options.workspace)) },
    ]));
    return await probeMcpServers(resolved, { cwd: options.workspace, wrap });
  } finally {
    await rm(scratchRoot, { recursive: true, force: true });
  }
}
