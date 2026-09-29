#!/usr/bin/env bun

import { Database } from "bun:sqlite";

export interface DeployOptions {
  database: string;
  service: string;
  healthUrl: string;
  stableChecks: number;
  pollMs: number;
  timeoutMs: number;
}

interface ActivityCounts {
  runs: number;
  stages: number;
}

function positiveInteger(value: string | undefined, name: string): number {
  if (!value || !/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a positive safe integer`);
  return parsed;
}

export function parseDeployOptions(args: readonly string[]): DeployOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error(`invalid argument near ${name ?? "end of input"}`);
    if (values.has(name)) throw new Error(`duplicate argument: ${name}`);
    values.set(name, value);
  }
  const known = new Set(["--database", "--service", "--health-url", "--stable-checks", "--poll-ms", "--timeout-ms"]);
  for (const name of values.keys()) {
    if (!known.has(name)) throw new Error(`unknown argument: ${name}`);
  }

  const database = values.get("--database");
  const service = values.get("--service");
  const healthUrl = values.get("--health-url");
  if (!database?.startsWith("/")) throw new Error("--database must be an absolute path");
  if (!service || !/^[A-Za-z0-9_.@-]+$/.test(service)) throw new Error("--service is invalid");
  if (!healthUrl) throw new Error("--health-url is required");
  const parsedHealthUrl = new URL(healthUrl);
  if (parsedHealthUrl.protocol !== "http:" && parsedHealthUrl.protocol !== "https:") {
    throw new Error("--health-url must use http or https");
  }

  return {
    database,
    service,
    healthUrl: parsedHealthUrl.href,
    stableChecks: positiveInteger(values.get("--stable-checks") ?? "3", "--stable-checks"),
    pollMs: positiveInteger(values.get("--poll-ms") ?? "2000", "--poll-ms"),
    timeoutMs: positiveInteger(values.get("--timeout-ms") ?? "21600000", "--timeout-ms"),
  };
}

export async function waitForStableIdle(
  readCounts: () => ActivityCounts | Promise<ActivityCounts>,
  options: Pick<DeployOptions, "stableChecks" | "pollMs" | "timeoutMs">,
  sleep: (milliseconds: number) => Promise<void> = Bun.sleep,
  now: () => number = Date.now,
): Promise<void> {
  const startedAt = now();
  let consecutiveIdleChecks = 0;
  while (true) {
    const counts = await readCounts();
    consecutiveIdleChecks = counts.runs === 0 && counts.stages === 0
      ? consecutiveIdleChecks + 1
      : 0;
    if (consecutiveIdleChecks >= options.stableChecks) return;
    if (now() - startedAt >= options.timeoutMs) {
      throw new Error("timed out waiting for Conveyor to become idle");
    }
    await sleep(options.pollMs);
  }
}

async function run(command: readonly string[]): Promise<void> {
  const process = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${stderr.trim() || stdout.trim() || `exit ${exitCode}`}`);
  }
}

async function verifyDeployment(service: string, healthUrl: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await run(["systemctl", "is-active", "--quiet", service]);
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return;
    } catch {
      // The process and HTTP listener can become ready at different moments.
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`deployment verification failed for ${service} at ${healthUrl}`);
}

async function main(): Promise<void> {
  const options = parseDeployOptions(Bun.argv.slice(2));
  const database = new Database(options.database, { readonly: true, strict: true });
  const activity = database.query(
    `SELECT
       (SELECT COUNT(*) FROM runs WHERE status = 'running') AS runs,
       (SELECT COUNT(*) FROM stage_states WHERE status = 'running') AS stages`,
  );
  console.log(`Waiting for ${options.service} to become durably idle...`);
  try {
    await waitForStableIdle(() => {
      const row = activity.get() as { runs: number; stages: number };
      return { runs: Number(row.runs), stages: Number(row.stages) };
    }, options);
  } finally {
    database.close();
  }

  console.log(`Restarting ${options.service}...`);
  await run(["systemctl", "restart", options.service]);
  await verifyDeployment(options.service, options.healthUrl);
  console.log(`Deployment verified: ${options.service} is active and ${options.healthUrl} is healthy.`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
