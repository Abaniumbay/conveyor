// conveyor service ...: the systemd system unit that runs `conveyor serve` under a dedicated,
// non-root account, with the home, configuration and executable recorded explicitly so the service
// never depends on a shell's directory or environment. Installing and removing the unit, and
// starting or stopping it, are administrative (root) steps; a drained restart is not.

import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { detectPrefix } from "../../release/install";
import { CliError, EXIT, parseDuration } from "../args";
import { printJson, stringOption, type Command, type CommandContext } from "../command";
import { control, ServiceUnavailable } from "../control-client";
import { homePaths } from "../home";

export interface Account {
  name: string;
  uid: number;
  gid: number;
  group: string;
  home: string;
}

async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

/** What the service commands touch outside Conveyor; tests replace it. */
export const systemd = {
  unitDirectory: "/etc/systemd/system",
  isRoot: (): boolean => process.getuid?.() === 0,
  systemctl: (args: string[]) => run(["systemctl", ...args]),
  /** The install prefix of the running conveyor. */
  prefix: () => detectPrefix(),
  async account(name: string): Promise<Account | null> {
    const entry = await run(["getent", "passwd", name]);
    if (entry.code !== 0 || !entry.stdout) return null;
    const [user, , uid, gid, , home] = entry.stdout.split(":");
    const group = await run(["getent", "group", gid!]);
    return { name: user!, uid: Number(uid), gid: Number(gid), group: group.stdout.split(":")[0] || gid!, home: home! };
  },
};

function unitFile(unit: string): string {
  return path.join(systemd.unitDirectory, `${unit}.service`);
}

function unitName(context: CommandContext): string {
  const unit = stringOption(context, "unit") ?? "conveyor";
  if (!/^[\w@.-]+$/.test(unit)) throw new CliError("--unit must be a systemd unit name", EXIT.usage);
  return unit;
}

/** Quotes an ExecStart argument when systemd would otherwise split or expand it. */
function quote(argument: string): string {
  return /^[\w@%+=:,./-]+$/.test(argument) ? argument : `"${argument.replace(/(["\\])/g, "\\$1")}"`;
}

export function renderUnit(options: { account: Account; home: string; config: string; executable: string; path: string }): string {
  const { account, home } = options;
  return `# Written by conveyor service install. Reinstall rather than editing by hand.
[Unit]
Description=Conveyor (${home})
Documentation=https://github.com/Abaniumbay/conveyor#readme
Wants=network-online.target
After=network-online.target

[Service]
Type=exec
User=${account.name}
Group=${account.group}
Environment=HOME=${account.home}
Environment=CONVEYOR_HOME=${home}
Environment=PATH=${options.path}
WorkingDirectory=${home}
ExecStart=${[options.executable, "serve", "--home", home, "--config", options.config].map(quote).join(" ")}
# Always restart: after a crash, and after a drained restart or upgrade, which exit on purpose.
Restart=always
RestartSec=5
# SIGTERM interrupts running agent work, which resumes after the next start; use
# \`conveyor service stop --drain\` to let it finish first.
KillMode=mixed
TimeoutStopSec=90
UMask=0027

[Install]
WantedBy=multi-user.target
`;
}

/** The unit's recorded home and configuration, from its file. */
export async function installedUnit(unit = "conveyor"): Promise<{ file: string; home: string; config: string | null; account: string | null } | null> {
  const file = unitFile(unit);
  const text = await readFile(file, "utf8").catch(() => null);
  if (!text) return null;
  const home = /^Environment=CONVEYOR_HOME=(.+)$/m.exec(text)?.[1];
  if (!home) return null;
  const config = /--config (\S+|"[^"]+")/.exec(/^ExecStart=(.+)$/m.exec(text)?.[1] ?? "")?.[1]?.replace(/^"|"$/g, "") ?? null;
  return { file, home, config, account: /^User=(.+)$/m.exec(text)?.[1] ?? null };
}

/** The command's context, with the home and configuration taken from the installed unit unless --home or --config is given. */
export async function withUnitHome(context: CommandContext, unit = "conveyor"): Promise<CommandContext> {
  if (context.options.home || context.options.config) return context;
  const installed = await installedUnit(unit);
  return installed ? { ...context, paths: homePaths(installed.home, installed.config ?? undefined) } : context;
}

async function systemctl(...args: string[]): Promise<string> {
  const result = await systemd.systemctl(args);
  if (result.code !== 0) {
    const permission = /access denied|interactive authentication|permission/i.test(result.stderr) ? " (run it with sudo)" : "";
    throw new CliError(`systemctl ${args.join(" ")} failed${permission}: ${result.stderr || result.stdout || `exit ${result.code}`}`, EXIT.failure);
  }
  return result.stdout;
}

function requireRoot(action: string): void {
  if (!systemd.isRoot()) throw new CliError(`${action} changes the system service: run it with sudo`, EXIT.failure);
}

const UNIT_OPTION = { unit: { type: "string", value: "<name>", description: "the systemd unit name (default: conveyor)" } } as const;
const DRAIN_OPTIONS = {
  drain: { type: "boolean", description: "stop admitting work and wait for running work to finish first" },
  timeout: { type: "string", value: "<duration>", description: "how long --drain waits (default 30m); then it gives up and admits work again" },
  force: { type: "boolean", description: "with --drain: go ahead when the timeout passes (running work is interrupted and resumes after the next start)" },
} as const;

interface ControlStatus { active: Array<{ item: string; stage: string }>; steering: number; startedAt: string; ready: boolean; version: { version: string } }

/** Drains the running service; resolves once idle, or (after `timeout`) throws unless `force`. */
async function drained(context: CommandContext): Promise<void> {
  const timeoutMs = parseDuration(stringOption(context, "timeout") ?? "30m", "--timeout");
  await control(context, "POST", "/v1/drain", { reason: "service stop or restart" });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await control<ControlStatus>(context, "GET", "/v1/status");
    if (status.active.length === 0 && status.steering === 0) return;
    if (Date.now() > deadline) {
      const running = status.active.map((entry) => `${entry.item} (${entry.stage})`).join(", ") || `${status.steering} steering run(s)`;
      if (context.options.force) {
        context.err(`Drain timed out; going ahead and interrupting: ${running}`);
        return;
      }
      await control(context, "DELETE", "/v1/drain");
      throw new CliError(`work is still running after ${stringOption(context, "timeout") ?? "30m"}: ${running}. Admission resumed; nothing was stopped (add --force to stop anyway).`, EXIT.failure);
    }
    context.err(`Waiting for running work: ${status.active.map((entry) => entry.item).join(", ") || "steering"}...`);
    await Bun.sleep(2_000);
  }
}

/** Waits for the control socket of a (re)started service; `after` excludes the process that was running. */
async function started(context: CommandContext, timeoutMs: number, after?: string): Promise<ControlStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await control<ControlStatus>(context, "GET", "/v1/status").catch(() => null);
    if (status && status.startedAt !== after) return status;
    if (Date.now() > deadline) throw new CliError("the service did not come up in time: see conveyor service status and journalctl -u conveyor", EXIT.failure);
    await Bun.sleep(500);
  }
}

export const serviceInstall: Command = {
  name: "service install",
  summary: "install the systemd system unit that runs conveyor serve under a non-root account (sudo)",
  options: {
    account: { type: "string", value: "<user>", description: "the account the service runs as (default: the user who ran sudo)" },
    path: { type: "string", value: "<PATH>", description: "PATH for the service: where git, gh, bwrap and the agent CLIs are" },
    ...UNIT_OPTION,
  },
  details: "Records the home, configuration and executable in the unit; enables but does not start it. The home and the install prefix must belong to the account, so it can run, upgrade and roll back without root.",
  async run(context) {
    requireRoot("service install");
    const unit = unitName(context);
    const name = stringOption(context, "account") ?? process.env.SUDO_USER;
    if (!name) throw new CliError("pass --account <user>: the service must run as a dedicated or chosen non-root account", EXIT.usage);
    const account = await systemd.account(name);
    if (!account) throw new CliError(`no account named ${name}`, EXIT.usage);
    if (account.uid === 0) throw new CliError("the service must not run as root: choose a dedicated or existing non-root account", EXIT.usage);
    const home = context.options.home ? context.paths.home : path.join(account.home, ".conveyor");
    const config = context.options.config ? context.paths.config : homePaths(home).config;
    const prefix = await systemd.prefix();
    if (!prefix) throw new CliError("run service install with the installed conveyor (<prefix>/versions/<version>/conveyor), not from a checkout", EXIT.usage);
    const problems: string[] = [];
    const homeInfo = await stat(home).catch(() => null);
    if (!homeInfo) problems.push(`${home} does not exist: run conveyor init as ${name} first (sudo -u ${name} conveyor init)`);
    else if (homeInfo.uid !== account.uid) problems.push(`${home} must belong to ${name}: sudo chown -R ${name}: ${home}`);
    if (!(await stat(config).catch(() => null))) problems.push(`${config} does not exist`);
    const prefixInfo = await stat(prefix).catch(() => null);
    if (prefixInfo && prefixInfo.uid !== account.uid) problems.push(`${prefix} must belong to ${name} so upgrades can switch releases: sudo chown -R ${name}: ${prefix}`);
    if (problems.length > 0) throw new CliError(["cannot install the service:", ...problems.map((problem) => `- ${problem}`)].join("\n"), EXIT.failure);

    const servicePath = stringOption(context, "path")
      ?? [path.join(account.home, ".local/bin"), path.join(account.home, ".bun/bin"), "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"].join(":");
    const file = unitFile(unit);
    await writeFile(file, renderUnit({ account, home, config, executable: path.join(prefix, "current/conveyor"), path: servicePath }), { mode: 0o644 });
    await systemctl("daemon-reload");
    await systemctl("enable", `${unit}.service`);
    if (context.json) return printJson(context, { unit, file, account: name, home, config, path: servicePath });
    context.out([
      `Installed and enabled ${file}`,
      `  runs ${path.join(prefix, "current/conveyor")} serve as ${name}`,
      `  home ${home}, configuration ${config}`,
      `  PATH ${servicePath}`,
      `Start it with: sudo conveyor service start${unit === "conveyor" ? "" : ` --unit ${unit}`}`,
    ].join("\n"));
  },
};

export const serviceStart: Command = {
  name: "service start",
  summary: "start the service and wait until it answers (sudo)",
  options: UNIT_OPTION,
  async run(rawContext) {
    const unit = unitName(rawContext);
    const context = await withUnitHome(rawContext, unit);
    await systemctl("start", `${unit}.service`);
    const status = await started(context, 60_000);
    context.out(`Started ${unit}: ${status.version.version}, ${status.ready ? "ready" : "starting up (see conveyor status)"}.`);
  },
};

export const serviceStop: Command = {
  name: "service stop",
  summary: "stop the service, optionally draining running work first (sudo)",
  options: { ...UNIT_OPTION, ...DRAIN_OPTIONS },
  async run(rawContext) {
    const unit = unitName(rawContext);
    const context = await withUnitHome(rawContext, unit);
    if (context.options.drain) await drained(context);
    await systemctl("stop", `${unit}.service`);
    context.out(`Stopped ${unit}.`);
  },
};

export const serviceRestart: Command = {
  name: "service restart",
  summary: "restart the service; with --drain it waits for running work and needs no sudo",
  options: { ...UNIT_OPTION, ...DRAIN_OPTIONS },
  async run(rawContext) {
    const unit = unitName(rawContext);
    const context = await withUnitHome(rawContext, unit);
    if (!context.options.drain) {
      await systemctl("restart", `${unit}.service`);
      const status = await started(context, 60_000);
      return context.out(`Restarted ${unit}: ${status.version.version}.`);
    }
    const before = await control<ControlStatus>(context, "GET", "/v1/status");
    await drained(context);
    await control(context, "POST", "/v1/restart");
    const status = await started(context, 120_000, before.startedAt);
    context.out(`Restarted ${unit} after draining: ${status.version.version}, ${status.ready ? "ready" : "starting up"}.`);
  },
};

export const serviceStatus: Command = {
  name: "service status",
  summary: "show the unit's state and the running service",
  options: UNIT_OPTION,
  async run(rawContext) {
    const unit = unitName(rawContext);
    const context = await withUnitHome(rawContext, unit);
    const installed = await installedUnit(unit);
    const properties = installed
      ? Object.fromEntries((await systemctl("show", `${unit}.service`, "--property=ActiveState,SubState,MainPID,ExecMainStartTimestamp,UnitFileState,NRestarts"))
        .split("\n").map((line) => line.split("=", 2) as [string, string]))
      : {};
    const service = await control<ControlStatus>(context, "GET", "/v1/status").catch((error: unknown) => {
      if (error instanceof ServiceUnavailable) return null;
      throw error;
    });
    const active = properties.ActiveState === "active";
    if (context.json) {
      printJson(context, { unit, installed: Boolean(installed), file: installed?.file ?? null, home: installed?.home ?? null, account: installed?.account ?? null, systemd: properties, service });
    } else if (!installed) {
      context.out(`${unit} is not installed (conveyor service install).`);
    } else {
      context.out([
        `${unit}: ${properties.ActiveState} (${properties.SubState}), ${properties.UnitFileState}${properties.MainPID && properties.MainPID !== "0" ? `, pid ${properties.MainPID}` : ""}`,
        `  unit ${installed.file}; runs as ${installed.account}; home ${installed.home}`,
        properties.ExecMainStartTimestamp ? `  started ${properties.ExecMainStartTimestamp}; restarts ${properties.NRestarts ?? 0}` : "",
        service ? `  serving ${service.version.version}, ${service.ready ? "ready" : "not ready"}` : "  not answering on its control socket",
      ].filter(Boolean).join("\n"));
    }
    return installed && active && service ? EXIT.ok : EXIT.unavailable;
  },
};

export const serviceUninstall: Command = {
  name: "service uninstall",
  summary: "stop, disable and remove the unit; the home and installed releases are kept (sudo)",
  options: UNIT_OPTION,
  async run(context) {
    requireRoot("service uninstall");
    const unit = unitName(context);
    const installed = await installedUnit(unit);
    if (!installed) throw new CliError(`${unit} is not installed`, EXIT.failure);
    await systemctl("disable", "--now", `${unit}.service`);
    await rm(installed.file, { force: true });
    await systemctl("daemon-reload");
    const prefix = await systemd.prefix();
    context.out([
      `Removed ${installed.file}. Nothing else was deleted:`,
      `  configuration, credentials and state: ${installed.home}`,
      ...(prefix ? [`  installed releases: ${prefix}`] : []),
      "Delete them yourself only if you no longer need them (for example: rm -rf <path>).",
    ].join("\n"));
  },
};
