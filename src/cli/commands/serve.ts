import { ConveyorService } from "../../app/service";
import { ReleaseCoordinator } from "../../control/releases";
import { releaseStateFile } from "../../release/state";
import { createControlHandler, serveControlSocket } from "../../control/server";
import { ConsoleSink, FileSink, log, Redactor } from "../../log/logger";
import { mcpSocketPath, serveMcpSocket } from "../../isolation/mcp-socket";
import { GhCliTransport, GitHubAdapter } from "../../source/github/adapter";
import { createGitHubCodeHostRegistry } from "../../source/github/codehost-registry";
import { BUILD, versionLine } from "../../version";
import { createWebAuth } from "../../web/auth";
import { pushConfiguration } from "../../web/push";
import { createWebHandler } from "../../web/server";
import { resolveSessionSecret } from "../../web/session-secret";
import { CliError, EXIT, type ExitCode } from "../args";
import { claimPidFile } from "../process-lock";

/** serve exits with this after a requested restart; the service unit restarts it. */
export const RESTART_EXIT_CODE = 75;
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
    // Warnings go through the service log (and its file), not straight to stderr.
    const config = await loadCommandConfig({ ...context, err: () => {} });
    // Before anything is opened: direct upgrade/rollback must see this process as running.
    await claimPidFile(context.paths.run).catch((error: unknown) => {
      throw new CliError(error instanceof Error ? error.message : String(error), EXIT.failure);
    });
    const { logging } = config.settings;
    log.configure({
      level: logging.level,
      redactor: new Redactor(config.secrets ?? []),
      sinks: [new ConsoleSink(logging.format), new FileSink(config.settings.logs, logging.maxFileMegabytes * 1024 * 1024, logging.keepFiles)],
    });
    for (const warning of config.warnings ?? []) log.warn(warning);
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
        log.error("Dashboard request failed", {}, error);
        return new Response("Internal server error", { status: 500 });
      },
    });
    // Sandboxed agents reach the MCP endpoint (only) through this Unix socket via the sandbox bridge.
    const mcpSocket = Object.values(config.repositories).some((repository) => repository.agentEgress?.allowLoopbackMcp)
      ? serveMcpSocket({ socket: mcpSocketPath(config.settings.artifacts), handler })
      : null;
    const dashboardUrl = config.web.publicUrl ?? server.url.href;
    let requestStop: (reason: string, exitCode?: number, afterClose?: () => Promise<void>) => void = () => {};
    const supervised = Boolean(process.env.INVOCATION_ID);
    const releases = new ReleaseCoordinator(service, context.paths.home, {
      supervised,
      restartExitCode: RESTART_EXIT_CODE,
      stop: (reason, code, afterClose) => requestStop(reason, code, afterClose),
    });
    // Bookkeeping of past switches must not keep the service from starting; a later upgrade or
    // rollback reports the same problem when it reads the file.
    await releases.onStartup().catch((error: unknown) => log.error("Could not record the outcome of the last release switch", { file: releaseStateFile(context.paths.home) }, error));
    const control = await serveControlSocket(context.paths.controlSocket, createControlHandler(service, {
      home: context.paths.home,
      config: context.paths.config,
      logs: config.settings.logs,
      database: config.settings.database,
      dashboardUrl,
      startedAt: new Date().toISOString(),
      supervised,
    }, { restart: () => requestStop("restart requested", RESTART_EXIT_CODE), releases })).catch(async (error: unknown) => {
      await server.stop(true);
      await mcpSocket?.stop();
      await service.close();
      throw new CliError(error instanceof Error ? error.message : String(error), EXIT.failure);
    });
    service.start();
    const dispatchPushEvents = () => Promise.resolve(webDependencies.dispatchPushEvents?.()).catch((error: unknown) => log.error("Push notification delivery failed", {}, error));
    const pushTimer = setInterval(() => void dispatchPushEvents(), 5_000);
    void dispatchPushEvents();
    log.info(`${versionLine()} started`, {
      version: BUILD.version, commit: BUILD.commit, config: config.hash.slice(0, 12), listen: server.url.href, dashboard: dashboardUrl,
      home: context.paths.home, logs: config.settings.logs,
    });

    const exitCode = await new Promise<number>((resolve) => {
      let stopping = false;
      requestStop = (reason, code = EXIT.ok, afterClose) => {
        if (stopping) return;
        stopping = true;
        log.info("Stopping Conveyor", { reason });
        void (async () => {
          clearInterval(pushTimer);
          await control.stop();
          await server.stop(false);
          await mcpSocket?.stop();
          await service.close();
          await afterClose?.().catch((error: unknown) => log.error("Finishing the stop failed", { reason }, error));
          log.info("Conveyor stopped", { reason });
          resolve(code);
        })();
      };
      process.on("SIGINT", () => requestStop("SIGINT"));
      process.on("SIGTERM", () => requestStop("SIGTERM"));
    });
    return exitCode as ExitCode;
  },
};
