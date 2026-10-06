import { access, constants, stat } from "node:fs/promises";
import net from "node:net";

import { ConfigError, loadConfig, type ConveyorConfig } from "../../config/load";
import { dashboardAccountCount } from "../../db/store";
import { scriptCommand } from "../../self";
import { EXIT } from "../args";
import { printJson, type Command } from "../command";
import { serviceRunning } from "../control-client";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  /** What to do about a warning or failure. */
  fix?: string;
}

async function run(argv: string[], timeoutMs = 15_000): Promise<{ code: number; output: string }> {
  try {
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    return { code: 127, output: error instanceof Error ? error.message : String(error) };
  }
}

function tool(name: string, command: string, install: string): DoctorCheck | null {
  return Bun.which(command) ? null : { name, status: "fail", detail: `${command} is not on PATH`, fix: install };
}

async function portAvailable(hostname: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, hostname, () => server.close(() => resolve(true)));
  });
}

/** Every check; `serviceRunning` tells whether the listen port may legitimately be taken. */
export async function doctorChecks(home: string, configPath: string, serviceRunning: () => Promise<boolean>): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const homeInfo = await stat(home).catch(() => undefined);
  if (!homeInfo?.isDirectory()) {
    checks.push({ name: "home", status: "fail", detail: `${home} does not exist`, fix: `conveyor init --home ${home}` });
  } else {
    const writable = await access(home, constants.W_OK).then(() => true, () => false);
    checks.push(writable
      ? { name: "home", status: "ok", detail: home }
      : { name: "home", status: "fail", detail: `${home} is not writable by this user`, fix: "run Conveyor as the account that owns its home" });
  }

  let config: ConveyorConfig | null = null;
  try {
    config = await loadConfig(configPath, undefined, { home });
    checks.push({ name: "configuration", status: "ok", detail: `${configPath} (${config.hash.slice(0, 12)})` });
    for (const warning of config.warnings ?? []) checks.push({ name: "configuration", status: "warn", detail: warning });
  } catch (error) {
    checks.push({
      name: "configuration",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      fix: error instanceof ConfigError ? "fix the configuration, then run conveyor config check" : "conveyor init",
    });
  }

  const git = tool("git", "git", "install Git (for example: sudo apt install git)");
  checks.push(git ?? { name: "git", status: "ok", detail: (await run(["git", "--version"])).output });

  const gh = tool("github cli", "gh", "install the GitHub CLI: https://cli.github.com");
  if (gh) checks.push(gh);
  else {
    const status = await run(["gh", "auth", "status"]);
    checks.push(status.code === 0
      ? { name: "github cli", status: "ok", detail: "authenticated" }
      : { name: "github cli", status: "fail", detail: "gh is not authenticated", fix: "gh auth login (as the account Conveyor runs under)" });
  }

  const bwrap = tool("sandbox", "bwrap", "install bubblewrap (for example: sudo apt install bubblewrap)");
  if (bwrap) checks.push(bwrap);
  else {
    const probe = await run(["bwrap", "--unshare-net", "--unshare-pid", "--die-with-parent", "--dev-bind", "/", "/", "true"]);
    checks.push(probe.code === 0
      ? { name: "sandbox", status: "ok", detail: "bwrap can create network and PID namespaces" }
      : { name: "sandbox", status: "fail", detail: `bwrap cannot create namespaces: ${probe.output}`, fix: "allow unprivileged user namespaces (for example: sysctl kernel.apparmor_restrict_unprivileged_userns=0, or an AppArmor profile for bwrap)" });
  }

  if (config) {
    const used = new Set(Object.values(config.agents).map((agent) => agent.runner));
    for (const name of [...used].sort()) {
      const runner = config.runners[name];
      if (!runner || !("command" in runner)) continue;
      const missing = tool(`harness ${name}`, runner.command, `install ${runner.command} and authenticate it as the account Conveyor runs under`);
      checks.push(missing ?? { name: `harness ${name}`, status: "ok", detail: Bun.which(runner.command)! });
    }
    for (const command of scriptInterpreters(config)) {
      const missing = tool(`script interpreter ${command}`, command, command === "bun"
        ? "install Bun (https://bun.sh), or set an interpreter for the scripts that need another one"
        : `install ${command}, or change the scripts' interpreter`);
      checks.push(missing ?? { name: `script interpreter ${command}`, status: "ok", detail: Bun.which(command)! });
    }
    for (const [id, repository] of Object.entries(config.repositories)) {
      const probe = await run(["git", "-C", repository.folder, "rev-parse", "--is-inside-work-tree"]);
      checks.push(probe.code === 0
        ? { name: `repository ${id}`, status: "ok", detail: repository.folder }
        : { name: `repository ${id}`, status: "fail", detail: `${repository.folder} is not a Git checkout`, fix: `git clone the repository into ${repository.folder}` });
    }
    const accounts = await accountCount(config.settings.database);
    checks.push(accounts > 0
      ? { name: "dashboard", status: "ok", detail: `${accounts} account(s)` }
      : { name: "dashboard", status: "fail", detail: "no dashboard account exists", fix: `conveyor init --home ${home}` });
    const separator = config.web.listen.lastIndexOf(":");
    const hostname = config.web.listen.slice(0, separator).replace(/^\[|\]$/g, "");
    const port = Number(config.web.listen.slice(separator + 1));
    if (await portAvailable(hostname, port)) checks.push({ name: "listen", status: "ok", detail: `${config.web.listen} is free` });
    else if (await serviceRunning()) checks.push({ name: "listen", status: "ok", detail: `${config.web.listen} is served by the running Conveyor` });
    else checks.push({ name: "listen", status: "fail", detail: `${config.web.listen} is in use by another process`, fix: "stop that process or change web.listen" });
  }
  return checks;
}

/** The commands the configured operator scripts start with (their interpreters, `bun` by default). */
export function scriptInterpreters(config: ConveyorConfig): string[] {
  const commands = new Set<string>();
  const add = (script: unknown, interpreter: unknown) => {
    if (typeof script !== "string") return;
    const argv = scriptCommand(script, Array.isArray(interpreter) ? interpreter.map(String) : undefined);
    if (argv.length > 1) commands.add(argv[0]!);
  };
  for (const plan of config.plans) {
    for (const stage of plan.stages) {
      for (const task of [...stage.actions, ...stage.exitGate]) {
        if (task.task === "script.run") add(task.with.script, task.with.interpreter);
      }
    }
  }
  for (const pipeline of Object.values(config.pipelines)) {
    for (const stage of pipeline.stages) {
      if ("run" in stage && stage.run.type === "script") add(stage.run.script, stage.run.interpreter);
    }
  }
  for (const check of Object.values(config.checks)) add(check.script, check.interpreter);
  return [...commands].sort();
}

async function accountCount(database: string): Promise<number> {
  if (!(await stat(database).catch(() => undefined))) return 0;
  // Read-only: a diagnostic must never migrate the database.
  return dashboardAccountCount(database);
}

const SYMBOL = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;

export const doctor: Command = {
  name: "doctor",
  summary: "check the home, configuration and every external prerequisite, with fixes",
  async run(context) {
    const checks = await doctorChecks(context.paths.home, context.paths.config, () => serviceRunning(context));
    const failed = checks.some((check) => check.status === "fail");
    if (context.json) printJson(context, { ok: !failed, checks });
    else {
      context.out(checks.map((check) => `${SYMBOL[check.status]}  ${check.name}: ${check.detail}${check.fix ? `\n        fix: ${check.fix}` : ""}`).join("\n"));
    }
    return failed ? EXIT.failure : EXIT.ok;
  },
};
