// pi is an npm package: its `pi` command is a Node script (`dist/bundle/cli.js`) that loads the rest of
// its bundle, assets and dependencies relative to itself. Conveyor launches that script with the
// interpreter its `#!` line names, both resolved to real files, and mounts the package read-only.
//
// pi's official installer keeps one npm release per directory under `~/.pi/agent/install/releases/`
// and puts a POSIX launcher at `~/.pi/agent/bin/pi` that picks the current release and the Node it
// installed. Conveyor resolves that layout itself, the way the launcher does, so the launcher (and the
// rest of `~/.pi/agent`, which holds the login) never enters the sandbox: only that release and its Node.
//
// Under `agentEgress` the pi process runs in the run's network namespace and reaches only its
// control-plane hosts through the token-protected control-plane proxy. Every command it runs (its
// bash tool, through `shellCommandPrefix`) and every MCP server it starts sources a file that
// removes what the pi process holds for itself and sets the data-plane proxy environment.

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { chmod, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveFilesystemPath } from "../../core/paths";
import type { Environment } from "../../isolation/environment";
import { startRunNetwork, withBridgeSockets, type AgentNetworkPolicy, type EgressInput, type RunNetwork } from "../../isolation/run-network";
import { agentLaunchCommand, verifyAgentWrapper, type AgentFilesystemOptions } from "../../isolation/sandbox";

/** The npm package pi is published as. */
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * The hosts the pi process reaches for a provider when the runner names no `controlPlaneHosts`, from
 * pi 1.5.2's provider definitions: the provider's base URL and, for a subscription login, the host
 * that refreshes its token. A provider whose host depends on the account (Azure's resource, GitHub
 * Copilot's plan) has none, and neither has a provider whose login refreshes at a host no agent
 * sandbox may reach (GitHub Copilot refreshes at api.github.com).
 */
export const PI_PROVIDER_CONTROL_PLANE_HOSTS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["api.anthropic.com", "platform.claude.com"],
  openai: ["api.openai.com", "auth.openai.com"],
  "openai-codex": ["chatgpt.com", "auth.openai.com"],
  google: ["generativelanguage.googleapis.com"],
  openrouter: ["openrouter.ai"],
};

/** The control-plane hosts of a pi runner: its own `controlPlaneHosts`, else its provider's; empty when it has neither. */
export function piControlPlaneHosts(runner: { controlPlaneHosts?: readonly string[] | undefined; provider?: string | undefined }): readonly string[] {
  if (runner.controlPlaneHosts) return runner.controlPlaneHosts;
  return (runner.provider !== undefined && Object.hasOwn(PI_PROVIDER_CONTROL_PLANE_HOSTS, runner.provider) ? PI_PROVIDER_CONTROL_PLANE_HOSTS[runner.provider] : undefined) ?? [];
}

export interface PiInstallation {
  /** The resolved `pi` executable: the package's CLI script, or a standalone build. */
  executable: string;
  /** The installed package's root. */
  packageRoot: string;
  /** The resolved interpreter a script executable names in its `#!` line, with its arguments; absent for a binary. */
  interpreter?: { path: string; args: string[] };
  /** The official installer's release the launcher would run; absent for any other installation. */
  release?: { version: string; directory: string };
}

/** The directory mounted read-only for pi: the official installer's release (the package and its dependencies), else the package root. */
export function piMountRoot(installation: PiInstallation): string {
  return installation.release?.directory ?? installation.packageRoot;
}

/** A release name the official launcher accepts. */
const RELEASE_VERSION = /^[0-9A-Za-z._+-]+$/;

/**
 * Finds the pi installation a runner's command names. The interpreter is resolved here and launched
 * by its real path, so a Node installed through symbolic links (a version manager, Homebrew) works
 * without exposing the directories that hold the links. `parent` is the service's environment, where
 * the official installer's Node is found (`XDG_DATA_HOME`, `HOME`); `env` is the run's.
 */
export function piInstallation(command: string, env: Record<string, string>, parent: Environment = process.env): PiInstallation {
  const resolved = agentLaunchCommand({ command, env });
  const managed = officialRelease(resolved);
  const executable = managed ? managed.executable : resolved;
  const packageRoot = findPackageRoot(executable);
  if (!packageRoot || (managed && !isWithin(packageRoot, managed.release.directory))) {
    throw new Error(managed
      ? `pi's official installer names release ${managed.release.version}, but ${managed.executable} is not part of an installed ${PI_PACKAGE} package in ${managed.release.directory}; reinstall pi`
      : `${command} (${executable}) is not part of an installed ${PI_PACKAGE} package; install pi with its installer or npm (npm install -g ${PI_PACKAGE}) and set the runner's command to its pi`);
  }
  const release = managed ? { release: managed.release } : {};
  const shebang = interpreterLine(executable);
  if (!shebang) return { executable, packageRoot, ...release };
  const [name, ...args] = shebang;
  // The launcher puts the Node the installer brought first on PATH, when it has one.
  const installerNode = managed ? installerNodeDirectory(parent) : undefined;
  const searchPath = [installerNode, env.PATH ?? ""].filter((entry) => entry !== undefined).join(path.delimiter);
  const found = path.isAbsolute(name!) ? name! : Bun.which(name!, { PATH: searchPath });
  if (!found || !existsSync(found)) {
    throw new Error(`pi (${executable}) runs on ${name}, which cannot be found${path.isAbsolute(name!) ? "" : ` on PATH (${searchPath || "unset"})`}; install it (pi needs Node.js 22.19 or newer)`);
  }
  return { executable, packageRoot, interpreter: { path: resolveFilesystemPath(found), args }, ...release };
}

/**
 * The release the official installer's launcher at `launcher` would run, recognised by its layout
 * rather than its text: `<agent>/bin/pi` beside `<agent>/install/current-version`. The version is
 * validated as the launcher does, and its release must hold the npm `pi` command.
 */
function officialRelease(launcher: string): { executable: string; release: { version: string; directory: string } } | undefined {
  const bin = path.dirname(launcher);
  if (path.basename(bin) !== "bin") return undefined;
  const install = path.join(path.dirname(bin), "install");
  const current = path.join(install, "current-version");
  if (!isFile(current)) return undefined;
  // Command substitution in the launcher drops the trailing newlines the installer writes.
  const version = readFileSync(current, "utf8").replace(/\n+$/, "");
  if (!RELEASE_VERSION.test(version) || version === "." || version === "..") {
    throw new Error(`pi's official installer names an invalid release in ${current} (${JSON.stringify(version)}); reinstall pi`);
  }
  const directory = path.join(install, "releases", version);
  const command = path.join(directory, "node_modules", ".bin", "pi");
  if (!existsSync(command)) {
    throw new Error(`pi's official installer names release ${version}, but ${command} is missing; reinstall pi`);
  }
  return { executable: resolveFilesystemPath(command), release: { version, directory: resolveFilesystemPath(directory) } };
}

/** The bin directory of the Node the official installer brought, when it holds an executable `node`. */
function installerNodeDirectory(parent: Environment): string | undefined {
  const data = parent.XDG_DATA_HOME || (parent.HOME ? path.join(parent.HOME, ".local", "share") : undefined);
  if (!data) return undefined;
  const directory = path.join(data, "pi-node", "current", "bin");
  try {
    const node = statSync(path.join(directory, "node"));
    return node.isFile() && (node.mode & 0o111) !== 0 ? directory : undefined;
  } catch {
    return undefined;
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function isWithin(candidate: string, directory: string): boolean {
  return candidate === directory || candidate.startsWith(`${directory}${path.sep}`);
}

/** The directory, at or above the executable, whose package.json names pi's package. */
function findPackageRoot(executable: string): string | undefined {
  let directory = path.dirname(executable);
  for (let depth = 0; depth < 6; depth++) {
    const manifest = path.join(directory, "package.json");
    try {
      if (statSync(manifest).isFile() && (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name === PI_PACKAGE) return directory;
    } catch {
      // A missing or unreadable manifest is not pi's; keep looking above it.
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

/** The interpreter and its arguments from a script's `#!` line (`env` and its options skipped); undefined for a binary. */
function interpreterLine(executable: string): string[] | undefined {
  let line: string;
  try {
    // Only the first line matters; a standalone build is a large binary.
    const descriptor = openSync(executable, "r");
    try {
      const head = Buffer.alloc(512);
      line = head.subarray(0, readSync(descriptor, head, 0, head.length, 0)).toString("utf8").split("\n", 1)[0] ?? "";
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return undefined;
  }
  if (!line.startsWith("#!")) return undefined;
  const words = line.slice(2).trim().split(/\s+/).filter(Boolean);
  if (path.basename(words[0] ?? "") !== "env") return words.length > 0 ? words : undefined;
  const rest = words.slice(1);
  while (rest[0]?.startsWith("-")) rest.shift();
  return rest.length > 0 ? rest : undefined;
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Where a run under egress keeps the environment file its commands and MCP servers source. */
export function piCommandEnvironmentFile(artifactsDirectory: string): string {
  return path.join(artifactsDirectory, "net", "command-environment");
}

/**
 * pi's `shellCommandPrefix` for a run. pi 1.5 runs each bash command as `<shellPath> -c
 * "<prefix>\n<command>"` with its own environment, so the prefix runs first in the command's shell.
 * Without egress it removes the variables pi holds for itself; under egress it sources the command
 * environment file, and a command whose file cannot be read never runs.
 */
export function piShellCommandPrefix(options: { unset: readonly string[]; commandEnvironment?: string | undefined }): string {
  return options.commandEnvironment ? `. ${shellQuote(options.commandEnvironment)} || exit 126` : `unset ${options.unset.join(" ")}`;
}

/** The program that starts an MCP server under egress: `<shell> -c <this> <file> <command> <args…>` sources the file, then runs the server. */
export const PI_MCP_LAUNCH = '. "$0" && exec "$@"';

/**
 * Writes the command environment file: it removes the variables the pi process holds for itself and
 * sets the data-plane proxy environment. POSIX shell, so both bash (the prefix) and sh can source it.
 */
export async function writePiCommandEnvironment(file: string, options: { unset: readonly string[]; dataEnv: Record<string, string> }): Promise<string> {
  const lines = [
    `unset ${options.unset.join(" ")}`,
    ...Object.entries(options.dataEnv).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    "",
  ];
  await writeFile(file, lines.join("\n"), { mode: 0o644 });
  await chmod(file, 0o644);
  return file;
}

/**
 * The argv/env to spawn pi inside the run's network namespace. The process reaches its model API
 * through the token-protected control-plane proxy (pi's HTTP clients follow `HTTPS_PROXY`); the
 * command environment file it was configured to source is written here with the data-plane proxy
 * environment and bound read-only, so no command can rewrite it. The caller closes `network`.
 */
export async function piLaunch(options: {
  environment: Record<string, string>;
  artifactsDirectory: string;
  egress: EgressInput;
  controlPlaneHosts: readonly string[];
  filesystem: AgentFilesystemOptions;
  /** pi's launch: its resolved interpreter or executable first, then its arguments. */
  argv: readonly string[];
  /** The variables the pi process holds for itself, which its commands lose. */
  unset: readonly string[];
}): Promise<{ argv: string[]; env: Record<string, string>; network: RunNetwork }> {
  const policy: AgentNetworkPolicy = { ...options.egress, controlPlaneHosts: options.controlPlaneHosts };
  const file = piCommandEnvironmentFile(options.artifactsDirectory);
  const network = await startRunNetwork({ directory: path.dirname(file), policy });
  try {
    const build = () => [...options.argv];
    let dataEnv: Record<string, string> = {};
    // The wrapper is pure; the first pass only learns the command proxy environment the file needs.
    network.wrap(options.environment, (env) => { dataEnv = env; return build(); }, withBridgeSockets(options.filesystem, policy));
    await writePiCommandEnvironment(file, { unset: options.unset, dataEnv });
    // Bound read-only over the writable artifacts mount, so the agent cannot rewrite its commands' environment.
    const filesystem = withBridgeSockets({ ...options.filesystem, readable: [...(options.filesystem.readable ?? []), file] }, policy);
    const sandboxed = network.wrap(options.environment, build, filesystem);
    verifyAgentWrapper(sandboxed, options.argv[0]);
    const owned: RunNetwork = { wrap: network.wrap, close: async () => { await network.close(); await rm(file, { force: true }); } };
    return { argv: sandboxed.argv, env: sandboxed.env, network: owned };
  } catch (error) {
    await network.close();
    await rm(file, { force: true });
    throw error;
  }
}
