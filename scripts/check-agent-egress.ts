#!/usr/bin/env bun
// Operator verification for agent egress enforcement (needs the real network; not part of `bun test`).
// Usage: bun scripts/check-agent-egress.ts <repository-id> --config <dir>
//
// Clones the repository locally, runs its dependency restore inside the network sandbox with an empty
// task-scoped cache and only the repository's `agentEgress.httpsHosts` reachable, then proves that
// api.github.com and direct IP connections are refused. Prints every refused host so the allowlist
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

    const run = async (name: string, argv: string[], env: Record<string, string> = {}, expectFailure = false): Promise<void> => {
      const sandboxed = sandboxCommand({ argv, env: { ...base, ...env }, dataProxySocket: proxy.socketPath });
      const child = Bun.spawn(sandboxed.argv, { cwd: work, env: sandboxed.env, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const ok = expectFailure ? code !== 0 : code === 0;
      if (!ok) failures += 1;
      console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` (exit ${code})`}`);
      if (!ok) console.log((err || out).split("\n").slice(-15).join("\n"));
    };

    const steps = restoreSteps(await readdir(work), path.join(scratch, "cache"));
    if (steps.length === 0) console.log("no restore commands detected for this repository");
    for (const step of steps) await run(`restore: ${step.name}`, step.argv, step.env);
    await run("api.github.com is refused", ["curl", "-sS", "--max-time", "15", "https://api.github.com"], {}, true);
    await run("direct IP connection is refused", ["curl", "-sS", "--noproxy", "*", "--max-time", "10", "https://1.1.1.1"], {}, true);
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
