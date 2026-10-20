import { access, constants, stat } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";

import { ConfigError, loadConfig, type ConveyorConfig } from "../../config/load";
import { dashboardAccountCount } from "../../db/store";
import { scriptCommand } from "../../self";
import { GhCliTransport, GitHubAdapter, type GitHubTransport } from "../../source/github/adapter";
import { publicRepositoryTrustPolicy } from "../../source/github/trust";
import { GITHUB_CALL_SOURCES } from "../../source/github/call-meter";
import type { GitHubCallReport } from "../../app/service";
import { EXIT } from "../args";
import { printJson, type Command } from "../command";
import { control, serviceRunning } from "../control-client";
import { filesystemPressure, filesystemPressureDetail, type FilesystemMeasure, type FilesystemPressure } from "../filesystem-pressure";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  /** What to do about a warning or failure. */
  fix?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  filesystems: FilesystemPressure[];
}

export interface DoctorCommand {
  (argv: string[], timeoutMs?: number): Promise<{ code: number; output: string }>;
}

interface CodexIsolationConfig {
  agents: Record<string, { runner: string }>;
  runners: Record<string, { type: string }>;
  repositories: Record<string, { agentEgress?: object | undefined }>;
}

const run: DoctorCommand = async (argv, timeoutMs = 15_000) => {
  try {
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    return { code: 127, output: error instanceof Error ? error.message : String(error) };
  }
};

function tool(name: string, command: string, install: string): DoctorCheck | null {
  return Bun.which(command) ? null : { name, status: "fail", detail: `${command} is not on PATH`, fix: install };
}

function codexIsolationConfigured(config: Pick<CodexIsolationConfig, "agents" | "runners">): boolean {
  return Object.values(config.agents).some((agent) => config.runners[agent.runner]?.type === "codex");
}

/** Checks the namespace and mount capabilities used by each configured Codex isolation mode. */
export async function configuredCodexIsolationChecks(
  config: CodexIsolationConfig,
  execute: DoctorCommand = run,
): Promise<DoctorCheck[]> {
  if (!codexIsolationConfigured(config)) return [];
  const repositories = Object.values(config.repositories);
  const checks: DoctorCheck[] = [];
  if (repositories.some((repository) => repository.agentEgress)) {
    const namespaces = await execute(["bwrap", "--unshare-net", "--unshare-pid", "--die-with-parent", "--ro-bind", "/", "/", "--", "true"]);
    checks.push(namespaces.code === 0
      ? { name: "Codex egress namespaces", status: "ok", detail: "bwrap can create network and PID namespaces" }
      : {
          name: "Codex egress namespaces",
          status: "fail",
          detail: `bwrap cannot create the network and PID namespaces required for Codex egress isolation: ${namespaces.output}`,
          fix: "allow unprivileged user namespaces and network/PID namespace creation for bwrap (for example: sysctl kernel.apparmor_restrict_unprivileged_userns=0, or an AppArmor profile for bwrap)",
        });
    const mounts = await execute(["bwrap", "--die-with-parent", "--dev-bind", "/", "/", "--proc", "/proc", "--tmpfs", "/tmp", "--", "true"]);
    checks.push(mounts.code === 0
      ? { name: "Codex egress mounts", status: "ok", detail: "bwrap can create the required filesystem mounts" }
      : {
          name: "Codex egress mounts",
          status: "fail",
          detail: `bwrap cannot create the filesystem mounts required for Codex egress isolation: ${mounts.output}`,
          fix: "allow bwrap to create mount namespaces and bind, proc, and tmpfs mounts (for example: grant the required AppArmor profile permissions)",
        });
  }
  if (repositories.some((repository) => !repository.agentEgress)) {
    const namespaces = await execute(["bwrap", "--unshare-user", "--die-with-parent", "--ro-bind", "/", "/", "--", "true"]);
    checks.push(namespaces.code === 0
      ? { name: "Codex sandbox namespaces", status: "ok", detail: "bwrap can create the user namespace required by the Codex sandbox" }
      : {
          name: "Codex sandbox namespaces",
          status: "fail",
          detail: `bwrap cannot create the user namespace required by the Codex sandbox: ${namespaces.output}`,
          fix: "allow unprivileged user namespaces for Codex (for example: sysctl kernel.apparmor_restrict_unprivileged_userns=0, or an AppArmor profile for bwrap)",
        });
  }
  return checks;
}

async function portAvailable(hostname: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, hostname, () => server.close(() => resolve(true)));
  });
}

/** Every check; `serviceRunning` tells whether the listen port may legitimately be taken. */
export async function doctorReport(
  home: string,
  configPath: string,
  serviceRunning: () => Promise<boolean>,
  github?: GitHubTransport,
  measureFilesystem?: FilesystemMeasure,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const filesystems: FilesystemPressure[] = [];
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

  const githubReady = !gh && checks[checks.length - 1]?.status === "ok";
  const transport = github ?? (githubReady ? new GhCliTransport() : null);
  if (config && codexIsolationConfigured(config)) {
    const bwrap = tool("sandbox", "bwrap", "install bubblewrap (for example: sudo apt install bubblewrap)");
    if (bwrap) checks.push(bwrap);
    else checks.push(...await configuredCodexIsolationChecks(config));
  }

  if (config) {
    filesystems.push(...await filesystemPressure({ artifacts: config.settings.artifacts, temporary: tmpdir() }, measureFilesystem));
    for (const filesystem of filesystems) {
      checks.push({
        name: `${filesystem.name} filesystem`,
        status: filesystem.status === "ok" ? "ok" : "warn",
        detail: filesystemPressureDetail(filesystem),
      });
    }
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
    const adapter = transport ? new GitHubAdapter(transport, config.settings.labelPrefix) : null;
    checks.push(...await repositoryTrustChecks(config, adapter));
    if (adapter) checks.push(...await issueMetadataChecks(config, adapter));
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
  return { checks, filesystems };
}

/** Backwards-compatible checks-only API for callers that do not need structured capacity data. */
export async function doctorChecks(
  home: string,
  configPath: string,
  serviceRunning: () => Promise<boolean>,
  github?: GitHubTransport,
  measureFilesystem?: FilesystemMeasure,
): Promise<DoctorCheck[]> {
  return (await doctorReport(home, configPath, serviceRunning, github, measureFilesystem)).checks;
}

/**
 * Reports the configured protections for public repositories. Visibility is read from GitHub so
 * a missing or unavailable source is always reported as uncertainty, rather than protection.
 */
export async function repositoryTrustChecks(
  config: ConveyorConfig,
  adapter: Pick<GitHubAdapter, "repositoryVisibility" | "collaboratorPermission" | "authenticatedLogin"> | null,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const [id, repository] of Object.entries(config.repositories)) {
    const extras = repository.extraTrustedLogins ?? [];
    const policy = `The effective default permission threshold is ${publicRepositoryTrustPolicy.permissionThreshold}; extra trusted logins: ${extras.length === 0 ? "none" : extras.join(", ")}. Conveyor ignores untrusted ${publicRepositoryTrustPolicy.ignoredInputCategories.join(", ")}.`;
    if (!adapter) {
      checks.push({
        name: `repository trust ${id}`,
        status: "warn",
        detail: `cannot determine whether ${repository.address} is public, so public-repository trust safeguards cannot be confirmed`,
        fix: `authenticate GitHub credentials with read access to ${repository.address}, then run conveyor doctor`,
      });
      continue;
    }
    try {
      const visibility = await adapter.repositoryVisibility(repository.address);
      if (visibility !== "public") {
        checks.push({ name: `repository trust ${id}`, status: "ok", detail: `This repository is private; the public-source status is not required. ${policy}` });
        continue;
      }
      // Probe the same GitHub endpoint the trust policy uses with a guaranteed user login. An
      // organization repository owner is not itself a valid collaborator-login probe.
      try {
        const login = await adapter.authenticatedLogin();
        await adapter.collaboratorPermission(repository.address, login);
        checks.push({ name: `repository trust ${id}`, status: "ok", detail: `This repository is public and GitHub author-permission lookups are available. ${policy}` });
      } catch (error) {
        checks.push({
          name: `repository trust ${id}`,
          status: "warn",
          detail: `This repository is public, but GitHub author-permission lookups cannot be confirmed: ${error instanceof Error ? error.message : String(error)}. ${policy}`,
          fix: `check GitHub access to collaborator permissions for ${repository.address}, then run conveyor doctor`,
        });
      }
    } catch (error) {
      checks.push({
        name: `repository trust ${id}`,
        status: "warn",
        detail: `cannot determine whether ${repository.address} is public, so public-repository trust safeguards cannot be confirmed: ${error instanceof Error ? error.message : String(error)}`,
        fix: `check GitHub read access to ${repository.address}, then run conveyor doctor`,
      });
    }
  }
  return checks;
}

/**
 * For each repository that configures refinement outputs: can the credentials read and write the
 * organization's issue types and issue fields? Read-only; no issue is changed.
 */
export async function issueMetadataChecks(config: ConveyorConfig, adapter: GitHubAdapter): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const [id, repository] of Object.entries(config.repositories)) {
    const outputs = repository.refinement;
    if (!outputs) continue;
    const wantsType = outputs.require.type;
    const wantsFields = outputs.fields.length > 0;
    if (!wantsType && !wantsFields) continue;
    const owner = repository.address.split("/")[0]!;
    const access = await adapter.probeIssueMetadata(repository.address);
    const fixRead = `give the GitHub credentials read access to ${owner}'s organization issue types and fields (gh auth refresh -s read:org, or a token with organization "Issue types/fields: read")`;
    const capability = (name: string, state: typeof access.types, wanted: boolean, noun: string) => {
      if (!wanted) return;
      if (state === "ok") checks.push({ name: `${name} ${id}`, status: "ok", detail: `${noun} readable for ${owner}` });
      else if (state === "none") checks.push({ name: `${name} ${id}`, status: "ok", detail: `${owner} defines no ${noun}; refinement will not require them` });
      else checks.push({
        name: `${name} ${id}`,
        status: "fail",
        detail: state === "denied" ? `the GitHub credentials cannot read ${noun} for ${owner} (repository ${repository.address})` : `${noun} for ${owner} could not be read`,
        fix: state === "denied" ? fixRead : "retry; if it persists check gh auth status and network access",
      });
    };
    capability("issue types", access.types, wantsType, "issue types");
    capability("issue fields", access.fields, wantsFields, "issue fields");
    if (access.canWrite === false) {
      checks.push({
        name: `issue metadata write ${id}`,
        status: "fail",
        detail: `the GitHub credentials cannot write issue types or issue-field values on ${repository.address}`,
        fix: `grant the account or token issue-management access to ${repository.address}; for a fine-grained token use "Issues: read and write"`,
      });
    } else if (access.canWrite === true) {
      checks.push({ name: `issue metadata write ${id}`, status: "ok", detail: `can write issue types and issue fields on ${repository.address}` });
    }
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

/** The doctor line for the running service's GitHub requests of the last hour and its rate limit. */
export function githubCallCheck(report: GitHubCallReport): DoctorCheck {
  const sources = GITHUB_CALL_SOURCES.filter((source) => report.bySource[source]).map((source) => `${source} ${report.bySource[source]}`);
  const since = Date.parse(report.countingSince) > Date.now() - report.windowMs ? ` since the service started at ${report.countingSince}` : " in the last hour";
  const calls = `${report.total} call${report.total === 1 ? "" : "s"}${since}${sources.length > 0 ? ` (${sources.join(", ")})` : ""}`;
  const limit = report.rateLimit;
  if (!limit) return { name: "GitHub calls", status: "ok", detail: `${calls}; the rate limit could not be read` };
  const remaining = `${limit.remaining} of ${limit.limit} requests left until ${limit.resetAt}`;
  return limit.remaining < limit.limit * 0.2
    ? { name: "GitHub calls", status: "warn", detail: `${calls}; only ${remaining}`, fix: "find the busiest source above; with healthy webhooks, waits and the reconcile read GitHub far less" }
    : { name: "GitHub calls", status: "ok", detail: `${calls}; ${remaining}` };
}

const SYMBOL = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;

export const doctor: Command = {
  name: "doctor",
  summary: "check the home, configuration, repository trust safeguards and external prerequisites, with fixes",
  async run(context) {
    const { checks, filesystems } = await doctorReport(context.paths.home, context.paths.config, () => serviceRunning(context));
    const calls = await control<GitHubCallReport>(context, "GET", "/v1/github-calls").catch(() => null);
    if (calls) checks.push(githubCallCheck(calls));
    const failed = checks.some((check) => check.status === "fail");
    if (context.json) printJson(context, { ok: !failed, checks, filesystems, warnings: filesystems.filter((filesystem) => filesystem.status === "warn") });
    else {
      context.out(checks.map((check) => `${SYMBOL[check.status]}  ${check.name}: ${check.detail}${check.fix ? `\n        fix: ${check.fix}` : ""}`).join("\n"));
    }
    return failed ? EXIT.failure : EXIT.ok;
  },
};
