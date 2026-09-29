#!/usr/bin/env bun
import { loadConfig } from "./config/load";
import { ConveyorService } from "./app/service";
import { createWebAuth, hashPassword } from "./web/auth";
import { createWebHandler } from "./web/server";

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

async function serve(configPath: string): Promise<void> {
  const config = await loadConfig(configPath);
  const username = process.env.CONVEYOR_USERNAME;
  if (!username) throw new Error("CONVEYOR_USERNAME is required");
  const auth = createWebAuth({
    passwordHash: process.env.CONVEYOR_PASSWORD_HASH,
    sessionSecret: process.env.CONVEYOR_SESSION_SECRET,
    secureCookies: config.web.publicUrl?.startsWith("https://") ?? false,
  });
  if (!auth.isConfigured) {
    throw new Error(
      "CONVEYOR_PASSWORD_HASH and a 32-byte CONVEYOR_SESSION_SECRET are required",
    );
  }
  const service = await ConveyorService.create(config);
  const handler = createWebHandler(service.webDependencies(auth, username));
  const server = Bun.serve({
    ...listenAddress(config.web.listen),
    fetch: handler,
    error(error) {
      console.error(error);
      return new Response("Internal server error", { status: 500 });
    },
  });
  service.start();
  console.log(`Conveyor ${config.hash.slice(0, 12)} listening on ${server.url}`);

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}; stopping Conveyor`);
    await server.stop(false);
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
    const config = await loadConfig(configPath);
    console.log(`Configuration is valid (${config.hash})`);
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
