#!/usr/bin/env bun
// Operator verification for agent egress enforcement (needs the real network; not part of `bun test`).
// Usage: bun scripts/check-agent-egress.ts <repository-id> --config <dir>
//
// Clones the repository locally, runs its dependency restore inside the network sandbox with an empty
// task-scoped cache and only the repository's `agentEgress.httpsHosts` reachable, then proves that
// api.github.com, direct IP connections and the Docker socket are refused, and that every configured
// local service answers at its sandbox endpoint. Prints every refused host so the allowlist
// can be completed.
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config/load";
import { startEgressProxy } from "../src/isolation/egress-proxy";
import { sanitizedAgentEnvironment } from "../src/isolation/environment";
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
  localServices?: readonly { endpoint: string; socket: string }[];
}

export interface SandboxedCheckResult {
  passed: boolean;
  exitCode: number;
  output: string;
}

/** Runs one probe inside the same sandbox as agent commands and decides whether it behaved as required. */
export async function runSandboxedCheck(options: SandboxedCheckOptions): Promise<SandboxedCheckResult> {
  const forwards = (options.localServices ?? []).map((service) => ({
    port: Number(service.endpoint.slice(service.endpoint.lastIndexOf(":") + 1)),
    socket: service.socket,
  }));
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

async function main(): Promise<number> {
  const args = Bun.argv.slice(2);
  const repositoryId = args[0];
  const configDirectory = args[args.indexOf("--config") + 1];
  if (!repositoryId || args.indexOf("--config") < 0 || !configDirectory) {
    console.error("usage: bun scripts/check-agent-egress.ts <repository-id> --config <dir>");
    return 2;
  }
  const config = await loadConfig(configDirectory, null);
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

    const localServices = repository.agentEgress.localServices ?? [];
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
