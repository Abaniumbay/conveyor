#!/usr/bin/env bun
// Operator verification for agent egress enforcement (needs the real network; not part of `bun test`).
// Usage: bun scripts/check-agent-egress.ts <repository-id> --config <conveyor.yaml> [--home <conveyor-home>] [--runner <runner-id> [--live]]
//
// Clones the repository locally, runs its dependency restore inside the network sandbox with an empty
// task-scoped cache and only the repository's `agentEgress.httpsHosts` reachable, then proves that
// a host the configuration does not list (api.github.com unless listed, else example.com), direct IP
// connections and the Docker socket are refused, and that every configured
// local service answers at its sandbox endpoint. Prints every refused host so the allowlist
// can be completed.
//
// With `--runner <id>` naming a Claude Code runner, it also launches probes the way the Claude Code
// runner does: the process itself may reach only the runner's `controlPlaneHosts` (through the
// token-protected control-plane proxy), its commands (`CLAUDE_CODE_SHELL_PREFIX`) only `httpsHosts`,
// and neither may reach an unlisted host or a direct IP. Commands are run exactly as Claude Code runs
// them: the prefix gets ONE argument, a command string.
//
// With `--live` (needs a Claude Code runner, its CLI and credentials) it also starts the real Claude
// Code CLI inside the run's namespace with a prompt that runs one `Bash` command against an allowed
// host and one against a refused host, and fails unless the first succeeds and the second is refused.
// Without `--live` the real CLI is not exercised, and the output says so.
//
// With `--runner <id>` naming a pi runner, the probes are launched the way the pi runner launches pi:
// the process reaches only the runner's control-plane hosts (its `controlPlaneHosts`, else its
// provider's), and a command, run as pi runs its bash tool (`<shell> -c "<shellCommandPrefix>\n<command>"`),
// only `httpsHosts`, without pi's agent directory or credential variables. `--live` starts the real pi
// CLI with a private copy of the runner's login (refreshed credentials go back, as after a run) and
// proves that its model answers and that its bash commands reach the allowed host and are refused a
// host outside `httpsHosts` and the control plane, without pi's agent directory or credentials.
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveFilesystemPath } from "../src/core/paths";
import { loadConfig, type ConveyorConfig } from "../src/config/load";
import { PLUGINS } from "../src/plugins";
import { parseLoopbackTcp } from "../src/isolation/egress-policy";
import { startEgressProxy } from "../src/isolation/egress-proxy";
import { agentEgressFor } from "../src/isolation/agent-egress";
import { resolveBash, sanitizedAgentEnvironment } from "../src/isolation/environment";
import { CLAUDE_CONTROL_PLANE_HOSTS, claudeLaunch } from "../src/plugins/claude-code/launch";
import { preparePiAgentDirectory, servicePiAgentDirectory, syncPiAgentDirectory } from "../src/plugins/pi/agent-directory";
import { piRunnerSchema } from "../src/plugins/pi/config";
import { piCommandEnvironmentFile, piControlPlaneHosts, piInstallation, piLaunch, piMountRoot, piShellCommandPrefix } from "../src/plugins/pi/launch";
import { piProcessVariables, piSettings } from "../src/plugins/pi/pi";
import { startTcpRelay } from "../src/isolation/tcp-relay";
import { agentLaunchCommand, sandboxCommand, type AgentFilesystemOptions } from "../src/isolation/sandbox";

export interface RestoreStep {
  name: string;
  argv: string[];
  env?: Record<string, string>;
}

/** The restore commands for the project types present in `files`, each with an empty cache under `scratch`. */
export function restoreSteps(files: readonly string[], scratch: string): RestoreStep[] {
  const has = (name: string): boolean => files.includes(name);
  const steps: RestoreStep[] = [];
  if (has("package-lock.json")) steps.push({ name: "npm", argv: ["npm", "ci", "--cache", path.join(scratch, "npm")] });
  if (has("pubspec.yaml")) steps.push({ name: "flutter", argv: ["flutter", "pub", "get"], env: { PUB_CACHE: path.join(scratch, "pub") } });
  if (files.some((file) => /\.(sln|csproj)$/.test(file))) steps.push({ name: "dotnet", argv: ["dotnet", "restore", "--packages", path.join(scratch, "nuget")] });
  if (has("gradlew")) steps.push({ name: "gradle", argv: ["./gradlew", "--gradle-user-home", path.join(scratch, "gradle"), "help"] });
  if (has("requirements.txt")) steps.push({ name: "pip", argv: ["pip", "download", "-r", "requirements.txt", "-d", path.join(scratch, "pip"), "--no-cache-dir"] });
  return steps;
}

export interface SandboxCheck {
  name: string;
  argv: string[];
  /** True when the probe must fail inside the sandbox (a refused connection is the pass). */
  expectFailure: boolean;
}

const DOCKER_SOCKETS = ["/var/run/docker.sock", "/run/docker.sock"] as const;

// The bridge's loopback listener accepts connections even when the service's Unix socket is missing,
// then closes them. So a connect alone proves nothing: the service is reachable only when the connection
// survives a short window or the service speaks first; an immediate close, reset or error means the
// upstream is down. It sends nothing, so it works for services that never speak first.
const SERVICE_PROBE = `
const socket = require("node:net").connect(Number(process.argv[2]), process.argv[1]);
const timer = setTimeout(() => process.exit(0), 1500);
socket.on("data", () => process.exit(0));
for (const event of ["close", "end", "error"]) socket.on(event, () => { clearTimeout(timer); process.exit(1); });`;

/** One probe per configured local service, connecting to its transport-neutral sandbox endpoint. */
export function localServiceChecks(services: readonly { name: string; endpoint: string }[]): SandboxCheck[] {
  return services.map((service) => {
    const separator = service.endpoint.lastIndexOf(":");
    const host = service.endpoint.slice(0, separator);
    const port = service.endpoint.slice(separator + 1);
    return {
      name: `local service ${service.name} is reachable at ${service.endpoint}`,
      argv: ["timeout", "10", process.execPath, "-e", SERVICE_PROBE, host, port],
      expectFailure: false,
    };
  });
}

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const CURL = "curl -sS --max-time 15 -o /dev/null";

/** A host the configuration lists nowhere, which the sandbox must refuse: api.github.com unless it is listed, else example.com. */
export function unlistedHost(options: { httpsHosts: readonly string[]; controlPlaneHosts: readonly string[] }): string | undefined {
  return ["api.github.com", "example.com"].find((host) => !options.httpsHosts.includes(host) && !options.controlPlaneHosts.includes(host));
}

/**
 * Probes for a Claude Code run, executed by `sh -c` as the Claude Code process would be: plain `curl`
 * is the process (control-plane proxy), `"$CLAUDE_CODE_SHELL_PREFIX" '<command string>'` (one executable path, one argument, as Claude Code runs it) is one of its `Bash` commands.
 */
export function claudeCodeChecks(options: { httpsHosts: readonly string[]; controlPlaneHosts: readonly string[] }): SandboxCheck[] {
  const [control] = options.controlPlaneHosts;
  const allowed = options.httpsHosts.find((host) => !options.controlPlaneHosts.includes(host));
  const unlisted = unlistedHost(options);
  const command = (name: string, script: string, expectFailure: boolean): SandboxCheck => ({ name, argv: ["sh", "-c", script], expectFailure });
  // One argument: the whole command string, as Claude Code calls the prefix.
  const prefixed = (command: string): string => `"$CLAUDE_CODE_SHELL_PREFIX" ${quote(command)}`;
  const checks: SandboxCheck[] = [];
  if (control) {
    checks.push(command(`claude-code process reaches its control-plane host ${control}`, `${CURL} ${quote(`https://${control}`)}`, false));
    checks.push(command(`claude-code command is refused the control-plane host ${control}`, prefixed(`${CURL} ${quote(`https://${control}`)}`), true));
  }
  if (allowed) {
    checks.push(command(`claude-code command reaches allowed host ${allowed}`, prefixed(`${CURL} ${quote(`https://${allowed}`)}`), false));
    checks.push(command(`claude-code process is refused non-control host ${allowed}`, `${CURL} ${quote(`https://${allowed}`)}`, true));
  }
  if (unlisted) {
    checks.push(command(`claude-code command: unlisted ${unlisted} is refused`, prefixed(`${CURL} https://${unlisted}`), true));
    checks.push(command(`claude-code process: unlisted ${unlisted} is refused`, `${CURL} https://${unlisted}`, true));
  }
  checks.push(
    command("claude-code command: direct IP connection is refused", prefixed(`${CURL} --noproxy '*' https://1.1.1.1`), true),
    command("claude-code command does not receive the control-plane credential", prefixed(`case "$HTTPS_PROXY" in *conveyor:*) exit 1;; esac`), false),
  );
  return checks;
}

/** The variable the pi probes read the run's `shellCommandPrefix` from (they stand in for the pi process). */
export const PI_PROBE_PREFIX = "PI_PROBE_PREFIX";

/** A command that fails when it holds pi's agent directory, one of `unset` or the control-plane credential. */
export function piCredentialCommand(unset: readonly string[]): string {
  return `test -z "${unset.map((name) => `\${${name}+x}`).join("")}" && case "$HTTPS_PROXY" in *conveyor:*) exit 1;; esac`;
}

/**
 * Probes for a pi run, executed by `sh -c` as the pi process would be: plain `curl` is the process
 * (control-plane proxy); `"$SHELL" -c "<prefix>\n<command>"` is one of its bash commands, exactly as
 * pi 1.5 runs them, with the prefix taken from `$PI_PROBE_PREFIX`.
 */
export function piChecks(options: { httpsHosts: readonly string[]; controlPlaneHosts: readonly string[]; unset: readonly string[] }): SandboxCheck[] {
  const [control] = options.controlPlaneHosts;
  const allowed = options.httpsHosts.find((host) => !options.controlPlaneHosts.includes(host));
  const unlisted = unlistedHost(options);
  const check = (name: string, script: string, expectFailure: boolean): SandboxCheck => ({ name, argv: ["sh", "-c", script], expectFailure });
  // pi joins its prefix and the command with a newline and hands both to its shell as one -c argument.
  const prefixed = (command: string): string => `"$SHELL" -c "$${PI_PROBE_PREFIX}"${quote(`\n${command}`)}`;
  const checks: SandboxCheck[] = [];
  if (control) {
    checks.push(check(`pi process reaches its control-plane host ${control}`, `${CURL} ${quote(`https://${control}`)}`, false));
    checks.push(check(`pi command is refused the control-plane host ${control}`, prefixed(`${CURL} ${quote(`https://${control}`)}`), true));
  }
  if (allowed) {
    checks.push(check(`pi command reaches allowed host ${allowed}`, prefixed(`${CURL} ${quote(`https://${allowed}`)}`), false));
    checks.push(check(`pi process is refused non-control host ${allowed}`, `${CURL} ${quote(`https://${allowed}`)}`, true));
  }
  if (unlisted) {
    checks.push(check(`pi command: unlisted ${unlisted} is refused`, prefixed(`${CURL} https://${unlisted}`), true));
    checks.push(check(`pi process: unlisted ${unlisted} is refused`, `${CURL} https://${unlisted}`, true));
  }
  checks.push(
    check("pi command: direct IP connection is refused", prefixed(`${CURL} --noproxy '*' https://1.1.1.1`), true),
    check("pi command does not receive the agent directory, credentials or control-plane credential", prefixed(piCredentialCommand(options.unset)), false),
  );
  return checks;
}

/** Probes that must fail: the host Docker socket may never be reachable from the sandbox. */
export function dockerSocketChecks(sockets: readonly string[] = DOCKER_SOCKETS): SandboxCheck[] {
  return sockets.map((socket) => ({
    name: `docker socket ${socket} is inaccessible`,
    argv: ["curl", "-sS", "--max-time", "10", "--unix-socket", socket, "http://localhost/_ping"],
    expectFailure: true,
  }));
}

/** Whether a probe's exit code is the expected outcome. */
export function checkPassed(check: Pick<SandboxCheck, "expectFailure">, exitCode: number): boolean {
  return check.expectFailure ? exitCode !== 0 : exitCode === 0;
}

export interface SandboxedCheckOptions {
  check: Pick<SandboxCheck, "argv" | "expectFailure">;
  /** Working directory of the probe. */
  cwd: string;
  /** Sanitized environment, merged with `env`. */
  base: Record<string, string>;
  env?: Record<string, string>;
  /** Unix socket of the data-plane egress proxy. */
  proxySocket: string;
  /** Repository-declared services, forwarded exactly as they are for agent commands. */
  localServices?: readonly LocalServiceEntry[];
}

type LocalServiceEntry = { endpoint: string } & ({ socket: string } | { tcp: string });

export interface SandboxedCheckResult {
  passed: boolean;
  exitCode: number;
  output: string;
}

/** Runs one probe inside the same sandbox as agent commands and decides whether it behaved as required. */
export async function runSandboxedCheck(options: SandboxedCheckOptions): Promise<SandboxedCheckResult> {
  const relays: { close(): Promise<void> }[] = [];
  const forwards: { port: number; socket: string }[] = [];
  try {
    for (const service of options.localServices ?? []) {
      const port = Number(service.endpoint.slice(service.endpoint.lastIndexOf(":") + 1));
      if ("socket" in service) {
        forwards.push({ port, socket: service.socket });
        continue;
      }
      const tcp = parseLoopbackTcp(service.tcp);
      if (!tcp) throw new Error(`local service ${service.endpoint} declares an invalid loopback tcp endpoint`);
      const relay = await startTcpRelay({ socketPath: path.join(path.dirname(options.proxySocket), `service-${port}.sock`), ...tcp });
      relays.push(relay);
      forwards.push({ port, socket: relay.socketPath });
    }
    return await runInSandbox(options, forwards);
  } finally {
    await Promise.all(relays.map((relay) => relay.close()));
  }
}

async function runInSandbox(options: SandboxedCheckOptions, forwards: { port: number; socket: string }[]): Promise<SandboxedCheckResult> {
  const sandboxed = sandboxCommand({
    argv: options.check.argv,
    env: { ...options.base, ...options.env },
    dataProxySocket: options.proxySocket,
    ...(forwards.length > 0 ? { localServices: forwards } : {}),
  });
  const child = Bun.spawn(sandboxed.argv, { cwd: options.cwd, env: sandboxed.env, stdout: "pipe", stderr: "pipe" });
  const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { passed: checkPassed(options.check, exitCode), exitCode, output: err || out };
}

/** Runs one Claude Code probe in the network sandbox exactly as the runner launches Claude Code. */
async function runClaudeCodeCheck(options: {
  check: SandboxCheck; scratch: string; workspace: string; base: Record<string, string>;
  egress: NonNullable<ReturnType<typeof agentEgressFor>>;
}): Promise<SandboxedCheckResult> {
  const directory = await mkdtemp(path.join(options.scratch, "claude-"));
  const [artifacts, home, temporary] = ["artifacts", "home", "tmp"].map((name) => path.join(directory, name)) as [string, string, string];
  await Promise.all([artifacts, home, temporary].map((target) => mkdir(target, { recursive: true })));
  const environment = { ...options.base, HOME: home, TMPDIR: temporary };
  const launch = await claudeLaunch({
    command: options.check.argv[0]!,
    environment,
    artifactsDirectory: artifacts,
    egress: options.egress,
    filesystem: { command: options.check.argv[0]!, env: environment, workspace: options.workspace, artifacts, home, scratch: temporary },
    buildArguments: () => options.check.argv.slice(1),
  });
  try {
    const child = Bun.spawn(launch.argv, { cwd: options.workspace, env: launch.env, stdout: "pipe", stderr: "pipe" });
    const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { passed: checkPassed(options.check, exitCode), exitCode, output: err || out };
  } finally {
    await launch.network.close();
  }
}

/** Runs one pi probe in the network sandbox exactly as the pi runner launches pi, with the command environment pi's commands source. */
export async function runPiCheck(options: {
  check: SandboxCheck; scratch: string; workspace: string; base: Record<string, string>;
  egress: NonNullable<ReturnType<typeof agentEgressFor>>; controlPlaneHosts: readonly string[];
  /** The runner's credential variables, set to a probe value for the process so its commands can prove they lose them. */
  credentialVariables: readonly string[];
}): Promise<SandboxedCheckResult> {
  const directory = await mkdtemp(path.join(options.scratch, "pi-"));
  const [artifacts, home, temporary] = ["artifacts", "home", "tmp"].map((name) => path.join(directory, name)) as [string, string, string];
  await Promise.all([artifacts, home, temporary].map((target) => mkdir(target, { recursive: true })));
  const unset = piProcessVariables(options.credentialVariables);
  const environment = {
    ...options.base, HOME: home, TMPDIR: temporary,
    ...Object.fromEntries(unset.map((name) => [name, name === unset[0] ? path.join(home, ".pi", "agent") : "probe-credential"])),
    [PI_PROBE_PREFIX]: piShellCommandPrefix({ unset, commandEnvironment: piCommandEnvironmentFile(artifacts) }),
  };
  const shell = agentLaunchCommand({ command: options.check.argv[0]!, env: environment });
  const launch = await piLaunch({
    environment,
    artifactsDirectory: artifacts,
    egress: options.egress,
    controlPlaneHosts: options.controlPlaneHosts,
    filesystem: { command: shell, env: environment, workspace: options.workspace, artifacts, home, scratch: temporary },
    argv: [shell, ...options.check.argv.slice(1)],
    unset,
  });
  try {
    const child = Bun.spawn(launch.argv, { cwd: options.workspace, env: launch.env, stdout: "pipe", stderr: "pipe" });
    const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { passed: checkPassed(options.check, exitCode), exitCode, output: err || out };
  } finally {
    await launch.network.close();
  }
}

export interface LiveHosts { allowed: string; refused: string }

/** The line printed when the real CLI was not run (no `--live`); nothing under `--live`. */
export function liveModeNote(live: boolean, harness = "Claude Code"): string | undefined {
  return live ? undefined : `NOTE the real ${harness} CLI was not exercised; run again with --live before turning on agentEgress for ${harness} agents`;
}

/** The hosts the live check probes: the first non-control `httpsHosts` entry, and one outside `httpsHosts`. */
export function liveHosts(options: { httpsHosts: readonly string[]; controlPlaneHosts: readonly string[] }): LiveHosts | undefined {
  const allowed = options.httpsHosts.find((host) => !options.controlPlaneHosts.includes(host));
  if (!allowed) return undefined;
  const refused = unlistedHost(options);
  return refused ? { allowed, refused } : undefined;
}

export const liveCommand = (host: string): string => `${CURL} https://${host}`;

/** The prompt for the real CLI: two `Bash` calls, one per host, reported verbatim. */
export function livePrompt(hosts: LiveHosts): string {
  return [
    "This is a network policy check. Use the Bash tool exactly twice, one command per call, in this order, and do not retry or modify either command:",
    `1. ${liveCommand(hosts.allowed)}`,
    `2. ${liveCommand(hosts.refused)}`,
    "Then reply with one line saying whether each command succeeded.",
  ].join("\n");
}

export const NOT_SIGNED_IN = "the Claude Code CLI is not signed in";

export interface LiveVerdict { passed: boolean; problems: string[] }

/** Reads Claude Code's stream-json output: the allowed command's `Bash` call must succeed, the refused one's must fail. */
export function judgeLiveOutput(output: string, hosts: LiveHosts): LiveVerdict {
  const calls = new Map<string, string>();
  const errored = new Map<string, boolean>();
  let notSignedIn = false;
  for (const line of output.split("\n")) {
    let event: { message?: { content?: unknown }; error?: unknown; result?: unknown };
    try { event = JSON.parse(line); } catch { continue; }
    if (event.error === "authentication_failed" || (typeof event.result === "string" && event.result.includes("Not logged in"))) notSignedIn = true;
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as { type?: string; id?: string; name?: string; input?: { command?: string }; tool_use_id?: string; is_error?: boolean }[]) {
      if (block.type === "tool_use" && block.name === "Bash" && block.id && typeof block.input?.command === "string") calls.set(block.id, block.input.command);
      if (block.type === "tool_result" && block.tool_use_id) errored.set(block.tool_use_id, block.is_error === true);
    }
  }
  if (notSignedIn) return { passed: false, problems: [NOT_SIGNED_IN] };
  const problems: string[] = [];
  // Only the exact commands the prompt asked for count: a modified command proves nothing about the connection.
  const outcome = (host: string): boolean | undefined => {
    const found = [...calls].find(([, command]) => command.trim() === liveCommand(host));
    return found ? errored.get(found[0]) : undefined;
  };
  const allowed = outcome(hosts.allowed);
  const refused = outcome(hosts.refused);
  if (allowed === undefined) problems.push(`no completed Bash command against ${hosts.allowed}`);
  else if (allowed) problems.push(`the Bash command against allowed host ${hosts.allowed} failed`);
  if (refused === undefined) problems.push(`no completed Bash command against ${hosts.refused}`);
  else if (!refused) problems.push(`the Bash command against ${hosts.refused} succeeded; it must be refused`);
  return { passed: problems.length === 0, problems };
}

/** Claude Code's arguments for the live check: only `Bash`, no user settings, no prompts. */
export function liveArguments(): string[] {
  return ["-p", "--output-format", "stream-json", "--verbose", "--setting-sources", "", "--tools", "Bash", "--allowedTools", "Bash", "--permission-mode", "dontAsk"];
}

const LIVE_TIMEOUT_MS = 300_000;

/**
 * The environment and filesystem the live check gives Claude Code, as `runClaudeCode` does: the
 * runner's `configDir` (else `CLAUDE_CONFIG_DIR`, else the service account's `~/.claude`) as
 * `CLAUDE_CONFIG_DIR`, mounted writable, and the token variables as control-plane variables.
 */
export function liveFilesystemOptions(options: {
  cli: string; base: Record<string, string>; credentials?: Record<string, string> | undefined;
  configDir?: string | undefined; serviceHome?: string | undefined;
  workspace: string; artifacts: string; home: string; scratch: string;
}): AgentFilesystemOptions {
  const configured = options.configDir ?? options.credentials?.CLAUDE_CONFIG_DIR ?? (options.serviceHome ? path.join(options.serviceHome, ".claude") : undefined);
  if (!configured) throw new Error("cannot locate the Claude Code config directory: set the runner's configDir, CLAUDE_CONFIG_DIR or HOME");
  const configDirectory = resolveFilesystemPath(configured);
  const env = { ...options.base, ...options.credentials, CLAUDE_CONFIG_DIR: configDirectory, HOME: options.home, TMPDIR: options.scratch };
  return { command: options.cli, env, workspace: options.workspace, artifacts: options.artifacts, home: options.home, scratch: options.scratch, writable: [configDirectory] };
}

/** Starts the real Claude Code CLI in the run's network namespace, exactly as the runner launches it, and judges its two `Bash` calls. */
export async function runLiveClaudeCheck(options: {
  cli: string; scratch: string; workspace: string; base: Record<string, string>;
  egress: NonNullable<ReturnType<typeof agentEgressFor>>; hosts: LiveHosts;
  /** Credentials the CLI needs for its own control-plane connection. */
  credentials?: Record<string, string>; configDir?: string | undefined; serviceHome?: string | undefined; timeoutMs?: number;
}): Promise<LiveVerdict & { output: string }> {
  const directory = await mkdtemp(path.join(options.scratch, "live-"));
  const [artifacts, home, temporary] = ["artifacts", "home", "tmp"].map((name) => path.join(directory, name)) as [string, string, string];
  await Promise.all([artifacts, home, temporary].map((target) => mkdir(target, { recursive: true })));
  const filesystem = liveFilesystemOptions({ ...options, artifacts, home, scratch: temporary });
  await mkdir(filesystem.env.CLAUDE_CONFIG_DIR!, { recursive: true });
  const launch = await claudeLaunch({
    command: options.cli,
    environment: filesystem.env,
    artifactsDirectory: artifacts,
    egress: options.egress,
    filesystem,
    buildArguments: liveArguments,
  });
  try {
    const child = Bun.spawn(launch.argv, { cwd: options.workspace, env: launch.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(livePrompt(options.hosts));
    void child.stdin.end();
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? LIVE_TIMEOUT_MS);
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).finally(() => clearTimeout(timer));
    const verdict = judgeLiveOutput(out, options.hosts);
    return { ...verdict, output: verdict.passed ? out : `${verdict.problems.join("\n")}\n${err || out}` };
  } finally {
    await launch.network.close();
  }
}

/** The bash commands the live pi check asks for, each with whether it must succeed. */
export function piLiveCommands(options: { hosts: LiveHosts; control: string; unset: readonly string[] }): { command: string; succeeds: boolean; description: string }[] {
  return [
    { command: liveCommand(options.hosts.allowed), succeeds: true, description: `reaches allowed host ${options.hosts.allowed}` },
    { command: liveCommand(options.hosts.refused), succeeds: false, description: `is refused ${options.hosts.refused}` },
    { command: liveCommand(options.control), succeeds: false, description: `is refused the control-plane host ${options.control}` },
    { command: piCredentialCommand(options.unset), succeeds: true, description: "does not receive pi's agent directory or credentials" },
  ];
}

/** The prompt for the real pi CLI: one bash call per command, in order, reported verbatim. */
export function piLivePrompt(commands: readonly { command: string }[]): string {
  return [
    `This is a network policy check. Use the bash tool exactly ${commands.length} times, one command per call, in this order, and do not retry or modify any command:`,
    ...commands.map((entry, index) => `${index + 1}. ${entry.command}`),
    "Then reply with one line saying whether each command succeeded.",
  ].join("\n");
}

/**
 * Reads pi's JSON-mode output: the model must have answered (its replies are not failed requests), and
 * each asked-for bash command must have completed as required. Only the exact commands count.
 */
export function judgePiLiveOutput(output: string, commands: readonly { command: string; succeeds: boolean; description: string }[]): LiveVerdict {
  const calls = new Map<string, string>();
  const errored = new Map<string, boolean>();
  let answered = false;
  let modelError: string | undefined;
  for (const line of output.split("\n")) {
    let event: { type?: string; toolCallId?: string; toolName?: string; args?: { command?: unknown }; isError?: boolean; message?: { role?: string; stopReason?: string; errorMessage?: string } };
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "tool_execution_start" && event.toolName === "bash" && event.toolCallId && typeof event.args?.command === "string") calls.set(event.toolCallId, event.args.command);
    if (event.type === "tool_execution_end" && event.toolCallId) errored.set(event.toolCallId, event.isError === true);
    if (event.type === "message_end" && event.message?.role === "assistant") {
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") modelError ??= event.message.errorMessage ?? `the response was ${event.message.stopReason}`;
      else answered = true;
    }
  }
  if (!answered) return { passed: false, problems: [`pi did not reach its model${modelError ? `: ${modelError}` : ""}`] };
  const problems: string[] = [];
  for (const expected of commands) {
    const found = [...calls].find(([, command]) => command.trim() === expected.command);
    const failed = found ? errored.get(found[0]) : undefined;
    if (failed === undefined) problems.push(`no completed bash command: ${expected.command}`);
    else if (failed === expected.succeeds) problems.push(`the bash command that ${expected.description} ${failed ? "failed" : "succeeded"}: ${expected.command}`);
  }
  return { passed: problems.length === 0, problems };
}

/** pi's arguments for the live check: JSON mode, only bash, nothing of the operator's or the project's, no session kept. */
export function piLiveArguments(options: { provider?: string | undefined; model?: string | undefined }): string[] {
  return [
    "--mode", "json", "--no-approve", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-session",
    "--tools", "bash",
    ...(options.model ? [...(options.provider ? ["--provider", options.provider] : []), "--model", options.model] : []),
  ];
}

/**
 * Starts the real pi CLI in the run's network namespace, exactly as the pi runner launches it (a
 * private copy of the runner's login, its credential variables for the process only, the command
 * environment pi's bash commands source), and judges its reply and bash calls. A login pi refreshed is
 * synchronised back to the service's agent directory, as after a run.
 */
export async function runLivePiCheck(options: {
  cli: string; scratch: string; workspace: string; base: Record<string, string>;
  egress: NonNullable<ReturnType<typeof agentEgressFor>>; controlPlaneHosts: readonly string[]; hosts: LiveHosts;
  /** The service's pi agent directory (the runner's configDir, else PI_CODING_AGENT_DIR, else ~/.pi/agent). */
  serviceDirectory: string;
  provider?: string | undefined; model?: string | undefined;
  /** The runner's credential variables with their values, for the pi process only. */
  credentials?: Record<string, string>; timeoutMs?: number;
}): Promise<LiveVerdict & { output: string }> {
  const directory = await mkdtemp(path.join(options.scratch, "live-pi-"));
  const [artifacts, home, temporary] = ["artifacts", "home", "tmp"].map((name) => path.join(directory, name)) as [string, string, string];
  await Promise.all([artifacts, home, temporary].map((target) => mkdir(target, { recursive: true })));
  const credentialVariables = Object.keys(options.credentials ?? {});
  const unset = piProcessVariables(credentialVariables);
  const shell = options.base.SHELL;
  if (!shell) throw new Error("the live pi check needs SHELL in its base environment");
  const agent = await preparePiAgentDirectory({
    home,
    serviceDirectory: options.serviceDirectory,
    settings: piSettings({ shell, credentialVariables, provider: options.provider, commandEnvironment: piCommandEnvironmentFile(artifacts) }),
    mcp: { autoEnableCodemode: false, mcpServers: {} },
  });
  try {
    const environment = { ...options.base, ...options.credentials, HOME: home, TMPDIR: temporary, PI_CODING_AGENT_DIR: agent.directory, PI_SKIP_VERSION_CHECK: "1" };
    const installation = piInstallation(options.cli, environment);
    const launched = installation.interpreter ? [installation.interpreter.path, ...installation.interpreter.args, installation.executable] : [installation.executable];
    const [control] = options.controlPlaneHosts;
    if (!control) throw new Error("the live pi check needs a control-plane host");
    const commands = piLiveCommands({ hosts: options.hosts, control, unset });
    const launch = await piLaunch({
      environment,
      artifactsDirectory: artifacts,
      egress: options.egress,
      controlPlaneHosts: options.controlPlaneHosts,
      filesystem: {
        command: launched[0]!, env: environment, workspace: options.workspace, artifacts, home, scratch: temporary,
        runtime: [piMountRoot(installation), ...(installation.interpreter ? [installation.interpreter.path] : [])],
      },
      argv: [...launched, ...piLiveArguments(options)],
      unset,
    });
    try {
      const child = Bun.spawn(launch.argv, { cwd: options.workspace, env: launch.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child.stdin.write(piLivePrompt(commands));
      void child.stdin.end();
      const timer = setTimeout(() => child.kill(), options.timeoutMs ?? LIVE_TIMEOUT_MS);
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).finally(() => clearTimeout(timer));
      const verdict = judgePiLiveOutput(out, commands);
      return { ...verdict, output: verdict.passed ? out : `${verdict.problems.join("\n")}\n${err || out}` };
    } finally {
      await launch.network.close();
    }
  } finally {
    // A refreshed login replaces the service's, so the next run does not start from a revoked one.
    await syncPiAgentDirectory({ home, serviceDirectory: options.serviceDirectory });
  }
}

/**
 * Loads the configuration for the check with the shipped plugins, which complete the runner settings
 * it reads; with the Conveyor home, `!include builtin:` entrypoints resolve.
 */
export function loadCheckConfig(target: string, home?: string): Promise<ConveyorConfig> {
  return loadConfig(target, null, { ...(home ? { home } : {}), plugins: PLUGINS });
}

async function main(): Promise<number> {
  const args = Bun.argv.slice(2);
  const repositoryId = args[0];
  const configDirectory = args[args.indexOf("--config") + 1];
  if (!repositoryId || args.indexOf("--config") < 0 || !configDirectory) {
    console.error("usage: bun scripts/check-agent-egress.ts <repository-id> --config <conveyor.yaml> [--home <conveyor-home>] [--runner <runner-id> [--live]]");
    return 2;
  }
  const live = args.includes("--live");
  const runnerId = args.includes("--runner") ? args[args.indexOf("--runner") + 1] : undefined;
  const homeIndex = args.indexOf("--home");
  const home = homeIndex >= 0 ? args[homeIndex + 1] : undefined;
  if (homeIndex >= 0 && !home) throw new Error("--home needs the Conveyor home directory");
  if (live && !runnerId) throw new Error("--live needs --runner <runner-id> (a claude-code or pi runner)");
  const config = await loadCheckConfig(configDirectory, home);
  const runner = runnerId ? config.runners[runnerId] : undefined;
  if (runnerId && runner?.type !== "claude-code" && runner?.type !== "pi") throw new Error(`--runner ${runnerId} must name a configured claude-code or pi runner`);
  const repository = config.repositories[repositoryId];
  if (!repository) throw new Error(`unknown repository: ${repositoryId}`);
  if (!repository.agentEgress) {
    throw new Error(`repository ${repositoryId} declares no agentEgress block, so its agents are not sandboxed`);
  }

  const scratch = await mkdtemp(path.join(tmpdir(), "egress-check-"));
  const denied = new Set<string>();
  const proxy = await startEgressProxy({
    socketPath: path.join(scratch, "data.sock"),
    allowedHosts: repository.agentEgress.httpsHosts,
    onDeny: (target, reason) => denied.add(`${target} (${reason})`),
  });
  let failures = 0;
  try {
    const work = path.join(scratch, "work");
    const clone = Bun.spawnSync(["git", "clone", "--quiet", "--local", repository.folder, work]);
    if (clone.exitCode !== 0) throw new Error(`git clone failed: ${clone.stderr.toString()}`);
    const privateHome = path.join(scratch, "home");
    await mkdir(privateHome, { recursive: true });
    const bash = resolveBash();
    if (!bash) throw new Error("bash is required to run agents and was not found");
    const base = { ...sanitizedAgentEnvironment(process.env, { home: privateHome, controlPlane: [] }), SHELL: bash };

    const localServices = (repository.agentEgress.localServices ?? []).map((service): LocalServiceEntry & { name: string } =>
      service.socket !== undefined ? { name: service.name, endpoint: service.endpoint, socket: service.socket } : { name: service.name, endpoint: service.endpoint, tcp: service.tcp ?? "" },
    );
    const run = async (name: string, argv: string[], env: Record<string, string> = {}, expectFailure = false): Promise<void> => {
      const result = await runSandboxedCheck({ check: { argv, expectFailure }, cwd: work, base, env, proxySocket: proxy.socketPath, localServices });
      if (!result.passed) failures += 1;
      console.log(`${result.passed ? "PASS" : "FAIL"} ${name}${result.passed ? "" : ` (exit ${result.exitCode})`}`);
      if (!result.passed) console.log(result.output.split("\n").slice(-15).join("\n"));
    };

    const steps = restoreSteps(await readdir(work), path.join(scratch, "cache"));
    if (steps.length === 0) console.log("no restore commands detected for this repository");
    for (const step of steps) await run(`restore: ${step.name}`, step.argv, step.env);
    const unlisted = unlistedHost({ httpsHosts: repository.agentEgress.httpsHosts, controlPlaneHosts: [] });
    if (unlisted) await run(`unlisted ${unlisted} is refused`, ["curl", "-sS", "--max-time", "15", `https://${unlisted}`], {}, true);
    await run("direct IP connection is refused", ["curl", "-sS", "--noproxy", "*", "--max-time", "10", "https://1.1.1.1"], {}, true);
    if (runner?.type === "claude-code") {
      const egress = agentEgressFor(config, repositoryId, runner)!;
      const controlPlaneHosts = egress.controlPlaneHosts ?? CLAUDE_CONTROL_PLANE_HOSTS;
      console.log(`claude-code runner ${runnerId}: control-plane hosts ${controlPlaneHosts.join(", ")}`);
      for (const check of claudeCodeChecks({ httpsHosts: repository.agentEgress.httpsHosts, controlPlaneHosts })) {
        const result = await runClaudeCodeCheck({ check, scratch, workspace: work, base, egress });
        if (!result.passed) failures += 1;
        console.log(`${result.passed ? "PASS" : "FAIL"} ${check.name}${result.passed ? "" : ` (exit ${result.exitCode})`}`);
        if (!result.passed) console.log(result.output.split("\n").slice(-15).join("\n"));
      }
      const note = liveModeNote(live);
      if (note) {
        console.log(note);
      } else {
        const hosts = liveHosts({ httpsHosts: repository.agentEgress.httpsHosts, controlPlaneHosts });
        if (!hosts) throw new Error("--live needs an httpsHosts entry that is not a control-plane host");
        const credentials = Object.fromEntries(
          (["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"] as const).flatMap((name) => (process.env[name] ? [[name, process.env[name]!]] : [])),
        );
        const result = await runLiveClaudeCheck({ cli: runner.command, scratch, workspace: work, base, egress, hosts, credentials, configDir: runner.configDir, serviceHome: process.env.HOME });
        if (!result.passed) failures += 1;
        console.log(`${result.passed ? "PASS" : "FAIL"} live claude-code: Bash reaches ${hosts.allowed} and is refused ${hosts.refused}`);
        if (!result.passed) console.log(result.output.split("\n").slice(-15).join("\n"));
      }
    }
    if (runner?.type === "pi") {
      const settings = piRunnerSchema.parse(runner);
      const egress = agentEgressFor(config, repositoryId, settings)!;
      const controlPlaneHosts = egress.controlPlaneHosts ?? piControlPlaneHosts(settings);
      if (controlPlaneHosts.length === 0) throw new Error(`pi runner ${runnerId} names no controlPlaneHosts and pi has no default hosts for its provider`);
      console.log(`pi runner ${runnerId}: control-plane hosts ${controlPlaneHosts.join(", ")}`);
      for (const check of piChecks({ httpsHosts: repository.agentEgress.httpsHosts, controlPlaneHosts, unset: piProcessVariables(settings.credentialVariables) })) {
        const result = await runPiCheck({ check, scratch, workspace: work, base, egress, controlPlaneHosts, credentialVariables: settings.credentialVariables });
        if (!result.passed) failures += 1;
        console.log(`${result.passed ? "PASS" : "FAIL"} ${check.name}${result.passed ? "" : ` (exit ${result.exitCode})`}`);
        if (!result.passed) console.log(result.output.split("\n").slice(-15).join("\n"));
      }
      const note = liveModeNote(live, "pi");
      if (note) {
        console.log(note);
      } else {
        const hosts = liveHosts({ httpsHosts: repository.agentEgress.httpsHosts, controlPlaneHosts });
        if (!hosts) throw new Error("--live needs an httpsHosts entry that is not a control-plane host");
        // The model of the first agent on this runner that names one; otherwise pi's default for the provider.
        const model = Object.values(config.agents).find((agent) => agent.runner === runnerId && agent.model)?.model;
        const credentials = Object.fromEntries(settings.credentialVariables.flatMap((name) => (process.env[name] ? [[name, process.env[name]!]] : [])));
        const serviceDirectory = resolveFilesystemPath(settings.configDir ?? servicePiAgentDirectory());
        const result = await runLivePiCheck({ cli: settings.command, scratch, workspace: work, base, egress, controlPlaneHosts, hosts, serviceDirectory, provider: settings.provider, model, credentials });
        if (!result.passed) failures += 1;
        console.log(`${result.passed ? "PASS" : "FAIL"} live pi: its model answers, bash reaches ${hosts.allowed} and is refused ${hosts.refused} and the control plane, without pi's credentials`);
        if (!result.passed) console.log(result.output.split("\n").slice(-15).join("\n"));
      }
    }
    for (const check of [...localServiceChecks(localServices), ...dockerSocketChecks()]) {
      await run(check.name, check.argv, {}, check.expectFailure);
    }
  } finally {
    await proxy.close();
    await rm(scratch, { recursive: true, force: true });
  }
  if (denied.size > 0) console.log(`\nRefused by the proxy:\n${[...denied].map((entry) => `  ${entry}`).join("\n")}`);
  console.log(failures === 0 ? "\nagent egress check passed" : `\nagent egress check FAILED (${failures})`);
  return failures === 0 ? 0 : 1;
}

if (import.meta.main) {
  main().then((code) => process.exit(code), (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
}
