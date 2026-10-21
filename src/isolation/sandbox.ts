import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { resolveFilesystemPath, resolvePathEnvironment } from "../core/paths";
import { INTERNAL, selfCommand } from "../self";

export const PROXY_VARIABLES = [
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
  "https_proxy", "http_proxy", "all_proxy", "no_proxy",
  "npm_config_https_proxy", "npm_config_proxy",
] as const;

export interface SandboxOptions {
  /** The command to run inside the network namespace. */
  argv: readonly string[];
  /** Its environment; proxy variables are added or replaced. */
  env: Record<string, string>;
  /** Unix socket of the data-plane (command) egress proxy. */
  dataProxySocket: string;
  /** Unix socket of the token-authenticated control-plane proxy; the wrapped command itself uses it. */
  controlProxySocket?: string;
  /** Required with `controlProxySocket`. */
  controlToken?: string;
  /** Forward this exact loopback port to the service's MCP-only Unix socket. */
  mcp?: { port: number; socket: string };
}

export interface SandboxedCommand {
  argv: string[];
  env: Record<string, string>;
  /** Proxy environment for commands the wrapped process runs (data-plane proxy). */
  dataEnv: Record<string, string>;
}

export interface ConfinedCommandOptions {
  /** The command which is allowed to run in the otherwise empty mount namespace. */
  argv: readonly string[];
  /** Its sanitized environment. */
  env: Record<string, string>;
  /** The only writable and readable application directory. */
  scratch: string;
  /** Individual files the command needs, such as a run-scoped MCP context. */
  readablePaths?: readonly string[];
  /** Executable installation directories the command needs to invoke its scoped MCP bridge. */
  runtimePaths?: readonly string[];
}

/** Runs locally with a private /tmp while preserving ordinary host networking. */
export function privateTmpCommand(options: { argv: readonly string[]; env: Record<string, string> }): SandboxedCommand {
  return {
    argv: ["bwrap", "--die-with-parent", "--dev-bind", "/", "/", ...isolationMounts(options.env.TMPDIR), "--", ...options.argv],
    env: resolvePathEnvironment(options.env),
    dataEnv: {},
  };
}

/**
 * Runs a command in an empty filesystem with only its scratch directory and individual run files.
 * This is deliberately separate from the ordinary isolation wrappers: it is for the board-only
 * Operator, whose process must not inherit the service's workspace or home mounts.
 */
/** Builds the mount namespace arguments before requiring the bubblewrap executable. */
export function confinedCommandPlan(options: ConfinedCommandOptions): SandboxedCommand {
  const command = options.argv[0];
  if (!command) throw new Error("cannot confine an empty command");
  const scratch = resolveFilesystemPath(options.scratch);
  if (!existsSync(scratch)) throw new Error(`Operator scratch directory does not exist: ${scratch}`);
  const executable = path.isAbsolute(command)
    ? resolveFilesystemPath(command)
    : findOnPath(command, options.env.PATH);
  if (!executable || !existsSync(executable)) throw new Error(`cannot confine a command that is not installed: ${command}`);

  const mounts = [
    "--tmpfs", "/",
    "--dir", "/usr",
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--dev", "/dev",
    "--proc", "/proc",
  ];
  const directories = new Set(["/", "/usr", "/dev", "/proc"]);
  const addDirectory = (directory: string) => {
    if (directories.has(directory) || directory.startsWith("/usr/")) return;
    const parent = path.dirname(directory);
    if (parent !== directory) addDirectory(parent);
    mounts.push("--dir", directory);
    directories.add(directory);
  };
  const addFile = (file: string) => {
    const target = path.resolve(file);
    const resolved = resolveFilesystemPath(file);
    if (!existsSync(resolved) || target === scratch || target.startsWith(`${scratch}/`) || target.startsWith("/usr/")) return;
    addDirectory(path.dirname(target));
    mounts.push("--ro-bind", resolved, target);
  };
  const addRuntimePath = (runtimePath: string) => {
    const target = path.resolve(runtimePath);
    const resolved = resolveFilesystemPath(runtimePath);
    if (!existsSync(resolved) || target === scratch || target.startsWith(`${scratch}/`) || target.startsWith("/usr/")) return;
    const isDirectory = statSync(resolved).isDirectory();
    const sourceDirectory = isDirectory ? resolved : path.dirname(resolved);
    const targetDirectory = isDirectory ? target : path.dirname(target);
    if (directories.has(targetDirectory)) return;
    addDirectory(path.dirname(targetDirectory));
    mounts.push("--ro-bind", sourceDirectory, targetDirectory);
    directories.add(targetDirectory);
  };
  // Bubblewrap creates bind targets only when their parents already exist in the new namespace.
  addDirectory(path.dirname(scratch));
  mounts.push("--bind", scratch, scratch);
  directories.add(scratch);
  // Codex and the MCP bridge can use adjacent runtime files, but no parent directory above
  // their resolved installation directory is made visible.
  addRuntimePath(executable);
  for (const runtimePath of options.runtimePaths ?? []) {
    if (path.isAbsolute(runtimePath)) addRuntimePath(runtimePath);
  }
  for (const file of options.readablePaths ?? []) {
    if (path.isAbsolute(file)) addFile(file);
  }
  const codexHome = options.env.CODEX_HOME;
  if (!codexHome) throw new Error("Operator filesystem confinement requires CODEX_HOME/auth.json");
  const credential = path.join(resolveFilesystemPath(codexHome), "auth.json");
  if (!existsSync(credential)) throw new Error("Operator filesystem confinement requires CODEX_HOME/auth.json");
  addFile(credential);
  if (existsSync("/etc/ssl/certs")) {
    addDirectory("/etc");
    mounts.push("--ro-bind", "/etc/ssl/certs", "/etc/ssl/certs");
  }
  for (const file of ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf"]) {
    if (existsSync(file)) addFile(file);
  }
  const env: Record<string, string> = { ...options.env, HOME: scratch, TMPDIR: scratch };
  return {
    argv: ["--unshare-pid", "--die-with-parent", "--new-session", ...mounts, "--chdir", scratch, "--", executable, ...options.argv.slice(1)],
    env: resolvePathEnvironment(env),
    dataEnv: {},
  };
}

/** Starts the fail-closed mount namespace for the board-only Operator. */
export function confinedCommand(options: ConfinedCommandOptions): SandboxedCommand {
  const plan = confinedCommandPlan(options);
  const bubblewrap = findOnPath("bwrap", options.env.PATH);
  if (!bubblewrap) throw new Error("Operator filesystem confinement requires bubblewrap");
  return { ...plan, argv: [bubblewrap, ...plan.argv] };
}

function findOnPath(command: string, pathValue: string | undefined): string | undefined {
  if (path.isAbsolute(command)) return resolveFilesystemPath(command);
  for (const directory of (pathValue ?? process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    if (existsSync(candidate)) return resolveFilesystemPath(candidate);
  }
  return undefined;
}


function proxyEnvironment(proxy: string, mcp: boolean): Record<string, string> {
  const noProxy = mcp ? "127.0.0.1" : "";
  return {
    HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy,
    https_proxy: proxy, http_proxy: proxy, all_proxy: proxy,
    npm_config_https_proxy: proxy, npm_config_proxy: proxy,
    NO_PROXY: noProxy, no_proxy: noProxy,
  };
}

function isWithin(pathname: string, directory: string): boolean {
  return pathname === directory || pathname.startsWith(`${directory}/`);
}

/** Returns active filesystem sockets at the paths the host network namespace exposes. */
function hostSocketPaths(): string[] {
  let table: string;
  try {
    table = readFileSync("/proc/net/unix", "utf8");
  } catch (error) {
    // Continuing without the host's socket table would make the egress boundary fail open.
    throw new Error("Cannot inspect host Unix sockets for egress isolation.", { cause: error });
  }
  const sockets = new Set<string>();
  for (const line of table.split("\n").slice(1)) {
    const pathname = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line)?.[1];
    if (!pathname || !path.isAbsolute(pathname)) continue;
    try {
      const resolved = resolveFilesystemPath(pathname);
      if (statSync(resolved).isSocket()) sockets.add(resolved);
    } catch {
      // Socket entries can disappear while the kernel table is being read.
    }
  }
  // Keep Docker explicitly covered even if its entry races with the kernel-table snapshot.
  for (const pathname of ["/var/run/docker.sock", "/run/docker.sock"]) {
    try {
      const resolved = resolveFilesystemPath(pathname);
      if (statSync(resolved).isSocket()) sockets.add(resolved);
    } catch {
      // Docker is optional and its socket can disappear while a run is starting.
    }
  }
  return [...sockets];
}

/**
 * Hides host path-based sockets from egress-isolated commands. The bridge is allowed to keep only
 * explicitly forwarded Unix sockets, which it translates into loopback TCP ports before the
 * wrapped command begins.
 */
function isolationMounts(runTmp: string | undefined, allowedSockets?: readonly string[]): string[] {
  const mounts = ["--proc", "/proc", "--tmpfs", resolveFilesystemPath("/tmp")];
  // The run's own temporary directory would vanish behind the private /tmp.
  const resolvedTmp = runTmp ? resolveFilesystemPath(runTmp) : undefined;
  if (resolvedTmp?.startsWith("/tmp/") && existsSync(resolvedTmp)) mounts.push("--bind", resolvedTmp, resolvedTmp);
  const runtime = `/run/user/${process.getuid?.() ?? 0}`;
  const resolvedRuntime = resolveFilesystemPath(runtime);
  if (existsSync(runtime)) mounts.push("--tmpfs", resolvedRuntime);
  if (!allowedSockets) return mounts;
  const allowed = new Set<string>();
  for (const socket of allowedSockets) {
    try {
      allowed.add(resolveFilesystemPath(socket));
    } catch {
      // A forward that disappears is reported by the bridge when it accepts a connection.
    }
  }
  for (const socket of hostSocketPaths()) {
    if (allowed.has(socket) || isWithin(socket, "/tmp") || isWithin(socket, resolvedRuntime)) continue;
    mounts.push("--ro-bind", "/dev/null", socket);
  }
  return mounts;
}

/**
 * Wraps a command in `bwrap --unshare-net`: the namespace has only a loopback, so the only way out
 * is the bridge, which forwards loopback ports to the per-run proxy Unix sockets (and, optionally,
 * the one MCP port) and then runs the command with the proxy environment set.
 */
export function sandboxCommand(options: SandboxOptions): SandboxedCommand {
  const taken = new Set<number>(options.mcp ? [options.mcp.port] : []);
  const freePort = (preferred: number): number => {
    let port = preferred;
    while (taken.has(port)) port += 2;
    taken.add(port);
    return port;
  };
  const dataPort = freePort(3128);
  const forwards = [{ port: dataPort, socket: options.dataProxySocket }];
  const dataEnv = proxyEnvironment(`http://127.0.0.1:${dataPort}`, Boolean(options.mcp));
  let commandEnv = dataEnv;
  if (options.controlProxySocket) {
    if (!options.controlToken) throw new Error("a control-plane proxy requires a token");
    const controlPort = freePort(3129);
    forwards.push({ port: controlPort, socket: options.controlProxySocket });
    const credentials = `conveyor:${encodeURIComponent(options.controlToken)}`;
    const control = `http://${credentials}@127.0.0.1:${controlPort}`;
    commandEnv = {
      ...proxyEnvironment(control, Boolean(options.mcp)),
      HTTP_PROXY: "", http_proxy: "", ALL_PROXY: "", all_proxy: "",
      npm_config_proxy: "", npm_config_https_proxy: "",
    };
  }
  if (options.mcp) forwards.push({ port: options.mcp.port, socket: options.mcp.socket });
  const spec = JSON.stringify({ forwards, command: options.argv });
  const allowedSockets = forwards.map((forward) => forward.socket);
  return {
    argv: ["bwrap", "--unshare-net", "--unshare-pid", "--die-with-parent", "--dev-bind", "/", "/", ...isolationMounts(options.env.TMPDIR, allowedSockets), "--", ...selfCommand(INTERNAL.bridge, spec)],
    env: resolvePathEnvironment({ ...options.env, ...commandEnv }),
    dataEnv,
  };
}
