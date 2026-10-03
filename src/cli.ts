#!/usr/bin/env bun
import { loadConfig } from "./config/load";
import { createTaskRegistry } from "./tasks/catalogue";
import type { TaskRegistry } from "./tasks/contract";
import { comparePlans } from "./tasks/compare-plans";
import { renderPlan } from "./tasks/plan";
import { ConveyorService } from "./app/service";
import { GhCliTransport, GitHubAdapter } from "./source/github/adapter";
import { createGitHubCodeHostRegistry } from "./source/github/codehost-registry";
import { createWebAuth, hashPassword } from "./web/auth";
import { createWebHandler } from "./web/server";
import { pushConfiguration } from "./web/push";
import { mcpSocketPath, serveMcpSocket } from "./isolation/mcp-socket";

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function listenAddress(value: string): { hostname: string; port: number } {
  const separator = value.lastIndexOf(":");
  const hostname = value.slice(0, separator).replace(/^\[|\]$/g, "");
  const port = Number(value.slice(separator + 1));
  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid listen address: ${value}`);
  }
  return { hostname, port };
}

/** The check-config report: the hash, then the expanded plan of each compilable repository. */
export async function checkConfig(
  configPath: string,
  registry: TaskRegistry = createTaskRegistry(),
): Promise<string> {
  const config = await loadConfig(configPath, registry);
  const plans = config.plans.map(renderPlan);
  return [`Configuration is valid (${config.hash})`, ...plans].join("\n\n");
}

/** Shadow comparison: compiles both configurations and prints their plans side by side. */
export async function compareConfigs(
  leftPath: string,
  rightPath: string,
  registry: TaskRegistry = createTaskRegistry(),
): Promise<string> {
  const [left, right] = await Promise.all([loadConfig(leftPath, registry), loadConfig(rightPath, registry)]);
  return [
    `Configuration is valid (${left.hash}) | Configuration is valid (${right.hash})`,
    comparePlans(left.plans, right.plans, { left: leftPath, right: rightPath }),
  ].join("\n\n");
}

async function serve(configPath: string): Promise<void> {
  const config = await loadConfig(configPath);
  const username = process.env.CONVEYOR_USERNAME;
  if (!username) throw new Error("CONVEYOR_USERNAME is required");
  const passwordHash = process.env.CONVEYOR_PASSWORD_HASH;
  if (!passwordHash) throw new Error("CONVEYOR_PASSWORD_HASH is required");
  const github = new GitHubAdapter(new GhCliTransport(), config.settings.labelPrefix);
  const service = await ConveyorService.create(
    config,
    github,
    createGitHubCodeHostRegistry(config, github),
  );
  const auth = createWebAuth({
    passwordHash,
    sessionSecret: process.env.CONVEYOR_SESSION_SECRET,
    secureCookies: config.web.publicUrl?.startsWith("https://") ?? false,
    username,
    accountById: (id) => service.dashboardAccountById(id),
    accountByUsername: (name) => service.dashboardAccountByUsername(name),
  });
  if (!auth.isConfigured) {
    throw new Error("CONVEYOR_PASSWORD_HASH and a 32-byte CONVEYOR_SESSION_SECRET are required");
  }
  service.seedDashboardSuperuser(username, passwordHash);
  const webDependencies = service.webDependencies(auth, username, pushConfiguration());
  const handler = createWebHandler(webDependencies);
  const server = Bun.serve({
    ...listenAddress(config.web.listen),
    fetch: handler,
    error(error) {
      console.error(error);
      return new Response("Internal server error", { status: 500 });
    },
  });
  // Sandboxed agents reach the MCP endpoint (only) through this Unix socket via the sandbox bridge.
  const mcpSocket = Object.values(config.repositories).some((repository) => repository.agentEgress?.allowLoopbackMcp)
    ? serveMcpSocket({ socket: mcpSocketPath(config.settings.artifacts), handler })
    : null;
  service.start();
  const dispatchPushEvents = () => Promise.resolve(webDependencies.dispatchPushEvents?.()).catch((error: unknown) => console.error("Push notification delivery failed", error));
  const pushTimer = setInterval(() => void dispatchPushEvents(), 5_000);
  void dispatchPushEvents();
  console.log(`Conveyor ${config.hash.slice(0, 12)} listening on ${server.url}`);

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}; stopping Conveyor`);
    clearInterval(pushTimer);
    await server.stop(false);
    await mcpSocket?.stop();
    await service.close();
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
}

export async function main(args = Bun.argv.slice(2)): Promise<void> {
  const command = args[0];
  if (command === "hash-password") {
    const password = option(args, "--password");
    if (!password) throw new Error("usage: conveyor hash-password --password <value>");
    console.log(hashPassword(password));
    return;
  }
  const configPath = option(args, "--config");
  if (!configPath) {
    throw new Error(`usage: conveyor ${command ?? "serve"} --config <file-or-directory>`);
  }
  if (command === "check-config") {
    const compare = option(args, "--compare");
    console.log(compare ? await compareConfigs(configPath, compare) : await checkConfig(configPath));
    return;
  }
  if (command === "serve") {
    await serve(configPath);
    return;
  }
  throw new Error(`unknown command: ${command ?? "(missing)"}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
