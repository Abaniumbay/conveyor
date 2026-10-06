import { ConveyorService } from "../../app/service";
import { mcpSocketPath, serveMcpSocket } from "../../isolation/mcp-socket";
import { GhCliTransport, GitHubAdapter } from "../../source/github/adapter";
import { createGitHubCodeHostRegistry } from "../../source/github/codehost-registry";
import { versionLine } from "../../version";
import { createWebAuth } from "../../web/auth";
import { pushConfiguration } from "../../web/push";
import { createWebHandler } from "../../web/server";
import { resolveSessionSecret } from "../../web/session-secret";
import { CliError, EXIT } from "../args";
import { loadCommandConfig, type Command } from "../command";

export function listenAddress(value: string): { hostname: string; port: number } {
  const separator = value.lastIndexOf(":");
  const hostname = value.slice(0, separator).replace(/^\[|\]$/g, "");
  const port = Number(value.slice(separator + 1));
  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid listen address: ${value}`);
  }
  return { hostname, port };
}

export const serve: Command = {
  name: "serve",
  summary: "run Conveyor in the foreground (the service unit runs this)",
  details: [
    "CONVEYOR_USERNAME with CONVEYOR_PASSWORD_HASH still seed the first administrator when no account",
    "exists (compatibility); `conveyor init` is the supported way.",
  ].join("\n"),
  async run(context) {
    const config = await loadCommandConfig(context);
    const github = new GitHubAdapter(new GhCliTransport(), config.settings.labelPrefix);
    const service = await ConveyorService.create(config, github, createGitHubCodeHostRegistry(config, github));
    const bootstrapUsername = process.env.CONVEYOR_USERNAME;
    const bootstrapHash = process.env.CONVEYOR_PASSWORD_HASH;
    if (bootstrapUsername && bootstrapHash) service.seedDashboardSuperuser(bootstrapUsername, bootstrapHash);
    const accounts = service.store.dashboardAccounts();
    if (accounts.length === 0) {
      await service.close();
      throw new CliError(`no dashboard account exists: run conveyor init${context.options.home ? ` --home ${context.paths.home}` : ""}`, EXIT.failure);
    }
    const auth = createWebAuth({
      passwordHash: undefined,
      sessionSecret: await resolveSessionSecret(config.web.sessionSecret, config.settings.database),
      secureCookies: config.web.publicUrl?.startsWith("https://") ?? false,
      accountById: (id) => service.dashboardAccountById(id),
      accountByUsername: (name) => service.dashboardAccountByUsername(name),
    });
    if (!auth.isConfigured) {
      await service.close();
      throw new CliError("the session secret must be at least 32 bytes (web.sessionSecret or CONVEYOR_SESSION_SECRET)", EXIT.config);
    }
    const operator = accounts.find((account) => account.role === "superuser")?.username ?? accounts[0]!.username;
    const webDependencies = service.webDependencies(auth, operator, pushConfiguration(config.web.push));
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
    console.log(`${versionLine()} with configuration ${config.hash.slice(0, 12)} listening on ${server.url}`);

    await new Promise<void>((resolve) => {
      let stopping = false;
      const stop = async (signal: string): Promise<void> => {
        if (stopping) return;
        stopping = true;
        console.log(`Received ${signal}; stopping Conveyor`);
        clearInterval(pushTimer);
        await server.stop(false);
        await mcpSocket?.stop();
        await service.close();
        resolve();
      };
      process.on("SIGINT", () => void stop("SIGINT"));
      process.on("SIGTERM", () => void stop("SIGTERM"));
    });
  },
};
