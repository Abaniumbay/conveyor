import { existsSync } from "node:fs";
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
export function confinedCommand(options: ConfinedCommandOptions): SandboxedCommand {
  const command = options.argv[0];
  if (!command) throw new Error("cannot confine an empty command");
  const bubblewrap = Bun.which("bwrap");
  if (!bubblewrap) throw new Error("Operator filesystem confinement requires bubblewrap");
  const scratch = resolveFilesystemPath(options.scratch);
  if (!existsSync(scratch)) throw new Error(`Operator scratch directory does not exist: ${scratch}`);
  const executable = path.isAbsolute(command)
    ? resolveFilesystemPath(command)
    : Bun.which(command);
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
    const resolved = resolveFilesystemPath(file);
    if (!existsSync(resolved) || resolved === scratch || resolved.startsWith(`${scratch}/`) || resolved.startsWith("/usr/")) return;
    addDirectory(path.dirname(resolved));
    mounts.push("--ro-bind", resolved, resolved);
  };
  // Bubblewrap creates bind targets only when their parents already exist in the new namespace.
  addDirectory(path.dirname(scratch));
  mounts.push("--bind", scratch, scratch);
  directories.add(scratch);
  addFile(executable);
  for (const file of options.readablePaths ?? []) {
    if (path.isAbsolute(file)) addFile(file);
  }
  if (existsSync("/etc/ssl/certs")) {
    addDirectory("/etc");
    mounts.push("--ro-bind", "/etc/ssl/certs", "/etc/ssl/certs");
  }
  const env: Record<string, string> = { ...options.env, HOME: scratch, TMPDIR: scratch };
  delete env.CODEX_HOME;
  return {
    argv: [bubblewrap, "--unshare-pid", "--die-with-parent", "--new-session", ...mounts, "--chdir", scratch, "--", executable, ...options.argv.slice(1)],
    env: resolvePathEnvironment(env),
    dataEnv: {},
  };
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

/**
 * Hides common host path-based sockets and processes: a private /proc (PID namespace), /tmp and
 * /run/user/<uid> (user bus, ssh/gpg agents), and the Docker socket. Other path sockets stay reachable.
 */
function isolationMounts(runTmp: string | undefined): string[] {
  const mounts = ["--proc", "/proc", "--tmpfs", resolveFilesystemPath("/tmp")];
  // The run's own temporary directory would vanish behind the private /tmp.
  const resolvedTmp = runTmp ? resolveFilesystemPath(runTmp) : undefined;
  if (resolvedTmp?.startsWith("/tmp/") && existsSync(resolvedTmp)) mounts.push("--bind", resolvedTmp, resolvedTmp);
  const runtime = `/run/user/${process.getuid?.() ?? 0}`;
  if (existsSync(runtime)) mounts.push("--tmpfs", resolveFilesystemPath(runtime));
  // /var/run is usually a symlink to /run; bwrap cannot mount through it, so mask resolved paths once.
  const sockets = new Set<string>();
  for (const socket of ["/var/run/docker.sock", "/run/docker.sock"]) {
    if (existsSync(socket)) sockets.add(resolveFilesystemPath(socket));
  }
  for (const socket of sockets) mounts.push("--ro-bind", "/dev/null", socket);
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
  return {
    argv: ["bwrap", "--unshare-net", "--unshare-pid", "--die-with-parent", "--dev-bind", "/", "/", ...isolationMounts(options.env.TMPDIR), "--", ...selfCommand(INTERNAL.bridge, spec)],
    env: resolvePathEnvironment({ ...options.env, ...commandEnv }),
    dataEnv,
  };
}
