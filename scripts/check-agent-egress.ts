#!/usr/bin/env bun
// Operator verification for agent egress enforcement (needs the real network; not part of `bun test`).
// Usage: bun scripts/check-agent-egress.ts <repository-id> --config <dir> [--runner <claude-code-runner-id>]
//
// Clones the repository locally, runs its dependency restore inside the network sandbox with an empty
// task-scoped cache and only the repository's `agentEgress.httpsHosts` reachable, then proves that
// api.github.com, direct IP connections and the Docker socket are refused, and that every configured
// local service answers at its sandbox endpoint. Prints every refused host so the allowlist
// can be completed.
//
// With `--runner <id>` naming a Claude Code runner, it also launches probes the way the Claude Code
// runner does: the process itself may reach only the runner's `controlPlaneHosts` (through the
// token-protected control-plane proxy), its commands (`CLAUDE_CODE_SHELL_PREFIX`) only `httpsHosts`,
// and neither may reach api.github.com or a direct IP.
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config/load";
import { parseLoopbackTcp } from "../src/isolation/egress-policy";
import { startEgressProxy } from "../src/isolation/egress-proxy";
import { agentEgressFor } from "../src/isolation/agent-egress";
import { sanitizedAgentEnvironment } from "../src/isolation/environment";
import { CLAUDE_CONTROL_PLANE_HOSTS, claudeLaunch } from "../src/isolation/run-network";
import { startTcpRelay } from "../src/isolation/tcp-relay";
import { sandboxCommand } from "../src/isolation/sandbox";

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

/**
 * Probes for a Claude Code run, executed by `sh -c` as the Claude Code process would be: plain `curl`
 * is the process (control-plane proxy), `$CLAUDE_CODE_SHELL_PREFIX curl` is one of its `Bash` commands.
 */
export function claudeCodeChecks(options: { httpsHosts: readonly string[]; controlPlaneHosts: readonly string[] }): SandboxCheck[] {
  const [control] = options.controlPlaneHosts;
  const allowed = options.httpsHosts.find((host) => !options.controlPlaneHosts.includes(host));
  const command = (name: string, script: string, expectFailure: boolean): SandboxCheck => ({ name, argv: ["sh", "-c", script], expectFailure });
  const prefixed = (curl: string): string => `$CLAUDE_CODE_SHELL_PREFIX ${curl}`;
  const checks: SandboxCheck[] = [];
  if (control) {
    checks.push(command(`claude-code process reaches its control-plane host ${control}`, `${CURL} ${quote(`https://${control}`)}`, false));
    checks.push(command(`claude-code command is refused the control-plane host ${control}`, prefixed(`${CURL} ${quote(`https://${control}`)}`), true));
  }
  if (allowed) {
    checks.push(command(`claude-code command reaches allowed host ${allowed}`, prefixed(`${CURL} ${quote(`https://${allowed}`)}`), false));
    checks.push(command(`claude-code process is refused non-control host ${allowed}`, `${CURL} ${quote(`https://${allowed}`)}`, true));
  }
  checks.push(
    command("claude-code command: api.github.com is refused", prefixed(`${CURL} https://api.github.com`), true),
    command("claude-code command: direct IP connection is refused", prefixed(`${CURL} --noproxy '*' https://1.1.1.1`), true),
    command("claude-code process: api.github.com is refused", `${CURL} https://api.github.com`, true),
    command("claude-code command does not receive the control-plane credential", prefixed(`sh -c 'case "$HTTPS_PROXY" in *conveyor:*) exit 1;; esac'`), false),
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

async function main(): Promise<number> {
  const args = Bun.argv.slice(2);
  const repositoryId = args[0];
  const configDirectory = args[args.indexOf("--config") + 1];
  if (!repositoryId || args.indexOf("--config") < 0 || !configDirectory) {
    console.error("usage: bun scripts/check-agent-egress.ts <repository-id> --config <dir> [--runner <claude-code-runner-id>]");
    return 2;
  }
  const runnerId = args.includes("--runner") ? args[args.indexOf("--runner") + 1] : undefined;
  const config = await loadConfig(configDirectory, null);
  const runner = runnerId ? config.runners[runnerId] : undefined;
  if (runnerId && runner?.type !== "claude-code") throw new Error(`--runner ${runnerId} must name a configured claude-code runner`);
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
    const home = path.join(scratch, "home");
    await mkdir(home, { recursive: true });
    const base = sanitizedAgentEnvironment(process.env, { home, controlPlane: [] });

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
    await run("api.github.com is refused", ["curl", "-sS", "--max-time", "15", "https://api.github.com"], {}, true);
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
