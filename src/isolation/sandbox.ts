import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  /** Repository-declared services exposed only through their configured loopback ports. */
  localServices?: readonly { port: number; socket: string }[];
  /** Narrow filesystem prepared for the agent command. */
  filesystem?: AgentFilesystemPlan;
}

export interface SandboxedCommand {
  argv: string[];
  env: Record<string, string>;
  /** Proxy environment for commands the wrapped process runs (data-plane proxy). */
  dataEnv: Record<string, string>;
}

/** The files an agent process may see inside its otherwise empty mount namespace. */
export interface AgentFilesystemOptions {
  command: string;
  env: Record<string, string>;
  workspace: string;
  artifacts: string;
  home: string;
  scratch: string;
  /** Whether Git's worktree metadata and shared object paths need local write access. */
  writableGit?: boolean;
  writable?: readonly string[];
  readable?: readonly string[];
  runtime?: readonly string[];
  /**
   * Repository-declared SDK and toolchain directories, mounted read-only. Unlike `readable`, one that
   * is missing or overlaps run material fails the plan, so no agent command starts without it.
   */
  toolchain?: readonly string[];
}

/** A prepared, narrow bubblewrap filesystem used by every agent harness. */
export interface AgentFilesystemPlan {
  mounts: string[];
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

/**
 * Builds the empty-root filesystem shared by Codex and Claude Code.  In particular this never
 * starts from a read-only host root: doing so makes hiding a few known secret directories a
 * blacklist with inevitable holes.
 */
export function agentFilesystemPlan(options: AgentFilesystemOptions): AgentFilesystemPlan {
  const workspace = requireDirectory(options.workspace, "workspace");
  const artifacts = requireDirectory(options.artifacts, "artifacts directory");
  const home = requireDirectory(options.home, "private home");
  const scratch = requireDirectory(options.scratch, "scratch directory");
  const executable = resolveCommand(options.command, options.env);
  if (!executable) throw new Error(`cannot confine a command that is not installed: ${options.command}`);

  const mounts = [
    "--tmpfs", "/",
    "--dir", "/usr",
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--dev", "/dev",
    "--proc", "/proc",
    // An empty /tmp is bubblewrap's work area, which the nested command shells need to start.
    "--dir", "/tmp",
  ];
  const directories = new Set(["/", "/usr", "/dev", "/proc", "/tmp"]);
  const addDirectory = (directory: string) => {
    const target = path.resolve(directory);
    if (directories.has(target) || target.startsWith("/usr/")) return;
    const parent = path.dirname(target);
    if (parent !== target) addDirectory(parent);
    mounts.push("--dir", target);
    directories.add(target);
  };
  const addPath = (sourcePath: string, writable: boolean, directoryOnly = false) => {
    const target = path.resolve(sourcePath);
    const source = resolveFilesystemPath(sourcePath);
    if (!existsSync(source) || target.startsWith("/usr/")) return;
    const stat = statSync(source);
    if (directoryOnly && !stat.isDirectory()) return;
    addDirectory(stat.isDirectory() ? target : path.dirname(target));
    mounts.push(writable ? "--bind" : "--ro-bind", source, target);
  };
  const writable = new Set((options.writable ?? []).filter(existsSync).map(resolveFilesystemPath));
  const runtimes = new Set<string>([executable, process.execPath, ...(options.runtime ?? [])]);
  for (const runtime of runtimes) {
    if (!path.isAbsolute(runtime) || !existsSync(runtime)) continue;
    const resolved = resolveFilesystemPath(runtime);
    if (resolved === "/") throw new Error("agent filesystem confinement cannot mount the host root as runtime");
    // An executable is a runtime file, not authority to read its installation directory.  In
    // particular, mounting its parent could reveal a service checkout or a sibling run.
    addPath(resolved, false);
  }
  const interpreter = scriptInterpreter(executable, options.env);
  if (interpreter) addPath(interpreter, false);
  // Mount runtimes before run material. A runtime package can be adjacent to an artifact or
  // scratch directory in tests and installations; the run's explicit writable mounts must win.
  // Its parent directories are otherwise only empty mount targets, so siblings stay invisible.
  addPath(workspace, writable.has(workspace), true);
  addPath(artifacts, true, true);
  addPath(home, true, true);
  addPath(scratch, true, true);
  // A linked worktree's .git file points at private metadata and a shared object store outside
  // the worktree. Git needs those reads even for reviewers, but nothing above those exact paths.
  const git = linkedGitPaths(workspace);
  for (const gitPath of git.directories) addPath(gitPath, options.writableGit || writable.has(gitPath), true);
  // Packed refs, configuration and exclude rules resolve names like `main` and `origin/main`; they stay read-only.
  for (const gitFile of git.files) addPath(gitFile, false);
  for (const writablePath of writable) addPath(writablePath, true, true);
  for (const readable of options.readable ?? []) addPath(readable, false);
  const runMaterial = [workspace, artifacts, home, scratch, ...git.directories, ...writable];
  for (const declared of options.toolchain ?? []) {
    const source = resolveFilesystemPath(declared);
    if (!path.isAbsolute(declared) || !existsSync(source) || !statSync(source).isDirectory()) {
      throw new Error(`agent toolchain path cannot be mounted: ${declared}`);
    }
    if (source === "/" || source === "/usr" || source.startsWith("/usr/")) {
      throw new Error(`agent toolchain path cannot be mounted: ${declared}`);
    }
    const overlap = runMaterial.find((run) => run === source || run.startsWith(`${source}/`) || source.startsWith(`${run}/`));
    if (overlap) throw new Error(`agent toolchain path ${declared} overlaps run path ${overlap}`);
    // Read-only, and added after the run's mounts only because it is proven not to overlap them.
    addPath(source, false, true);
  }
  for (const file of ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf"]) addPath(file, false);
  if (existsSync("/etc/ssl/certs")) addPath("/etc/ssl/certs", false, true);
  return { mounts };
}

export interface CommandShellOptions {
  /** A run-owned directory that receives the wrapper scripts. */
  directory: string;
  /** The harness environment; its PATH locates bubblewrap and is the one the shells are put in front of. */
  env: Record<string, string>;
  /** Harness credential files which the harness reads but the commands it runs must not. */
  masked: readonly string[];
}

export interface CommandShellLaunch {
  /** The harness environment with the wrapper shells first on PATH and as SHELL. */
  env: Record<string, string>;
  /** Mount these read-only so a command cannot rewrite the wrappers. */
  readable: string[];
  /** Mount these as runtime files; bubblewrap itself when it lives outside /usr. */
  runtime: string[];
}

const COMMAND_SHELLS = ["bash", "sh", "zsh"] as const;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The harness shares its mount namespace with the commands it runs, so a credential it needs is
 * also readable by them. Agent harnesses run commands through a shell found on PATH (or SHELL), so
 * this puts wrapper shells first: each re-enters a nested bubblewrap which replaces the existing
 * credential files by an empty one and then runs the real shell. The harness itself keeps them.
 * A command which names an absolute shell path bypasses the wrapper; this narrows the exposure
 * rather than replacing a harness-enforced command sandbox.
 */
export function commandShellLaunch(options: CommandShellOptions): CommandShellLaunch {
  const bubblewrap = findOnPath("bwrap", options.env.PATH);
  if (!bubblewrap) throw new Error("agent filesystem confinement requires bubblewrap");
  const directory = path.resolve(options.directory);
  mkdirSync(directory, { recursive: true });
  const masked = options.masked.map((file) => shellQuote(path.resolve(file))).join(" ");
  const script = (real: string) => [
    "#!/bin/sh",
    `set -- -- ${shellQuote(real)} "$@"`,
    `for credential in ${masked}; do`,
    '  if [ -f "$credential" ]; then set -- --ro-bind /dev/null "$credential" "$@"; fi',
    "done",
    `exec ${shellQuote(bubblewrap)} --die-with-parent --dev-bind / / --chdir "$PWD" "$@"`,
    "",
  ].join("\n");
  for (const name of COMMAND_SHELLS) {
    const real = [`/usr/bin/${name}`, "/usr/bin/bash", "/usr/bin/sh"].find((candidate) => existsSync(candidate));
    if (!real) throw new Error(`no shell is installed for the ${name} command wrapper`);
    const file = path.join(directory, name);
    writeFileSync(file, script(real), { mode: 0o755 });
    chmodSync(file, 0o755);
  }
  const resolved = resolveFilesystemPath(directory);
  return {
    env: { ...options.env, PATH: [resolved, options.env.PATH].filter(Boolean).join(path.delimiter), SHELL: path.join(resolved, "bash") },
    readable: [resolved],
    runtime: bubblewrap.startsWith("/usr/") ? [] : [bubblewrap],
  };
}

/** Starts an agent with its constrained filesystem, failing before the agent command can run. */
export function agentFilesystemCommand(options: AgentFilesystemOptions, argv: readonly string[]): SandboxedCommand {
  const plan = agentFilesystemPlan(options);
  const bubblewrap = findOnPath("bwrap", options.env.PATH);
  if (!bubblewrap) throw new Error("agent filesystem confinement requires bubblewrap");
  return { argv: [bubblewrap, "--unshare-pid", "--die-with-parent", ...plan.mounts, "--", ...argv], env: resolvePathEnvironment(options.env), dataEnv: {} };
}

function requireDirectory(value: string, description: string): string {
  const resolved = resolveFilesystemPath(value);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw new Error(`agent filesystem confinement requires ${description}`);
  return resolved;
}

function resolveCommand(command: string, env: Record<string, string>): string | undefined {
  const executable = path.isAbsolute(command) ? resolveFilesystemPath(command) : findOnPath(command, env.PATH);
  return executable && existsSync(executable) ? executable : undefined;
}

function scriptInterpreter(executable: string, env: Record<string, string>): string | undefined {
  try {
    const line = readFileSync(executable, "utf8").split("\n", 1)[0] ?? "";
    const words = line.startsWith("#!") ? line.slice(2).trim().split(/\s+/) : [];
    const command = path.basename(words[0] ?? "") === "env" ? words[1] : words[0];
    return command ? resolveCommand(command, env) : undefined;
  } catch {
    return undefined;
  }
}

function linkedGitPaths(workspace: string): { directories: string[]; files: string[] } {
  const dotGit = path.join(workspace, ".git");
  const none = { directories: [], files: [] };
  try {
    if (!statSync(dotGit).isFile()) return none;
    const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (!match?.[1]) return none;
    const gitDir = resolveFilesystemPath(path.resolve(workspace, match[1]));
    const common = path.join(gitDir, "commondir");
    const commonDir = existsSync(common)
      ? resolveFilesystemPath(path.resolve(gitDir, readFileSync(common, "utf8").trim()))
      : gitDir;
    const inCommon = (names: string[]) => names.map((name) => path.join(commonDir, name)).filter(existsSync);
    return {
      directories: [gitDir, ...inCommon(["objects", "refs", "logs"])],
      files: inCommon(["packed-refs", "config", "info/exclude"]),
    };
  } catch {
    // A non-Git workspace has no administrative paths to expose.
    return none;
  }
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


function proxyEnvironment(proxy: string, loopbackService: boolean): Record<string, string> {
  const noProxy = loopbackService ? "127.0.0.1" : "";
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
  const servicePorts = options.localServices?.map((service) => service.port) ?? [];
  const taken = new Set<number>([...servicePorts, ...(options.mcp ? [options.mcp.port] : [])]);
  const loopbackService = Boolean(options.mcp || options.localServices?.length);
  const freePort = (preferred: number): number => {
    let port = preferred;
    while (taken.has(port)) port += 2;
    taken.add(port);
    return port;
  };
  const dataPort = freePort(3128);
  const forwards = [{ port: dataPort, socket: options.dataProxySocket }];
  const dataEnv = proxyEnvironment(`http://127.0.0.1:${dataPort}`, loopbackService);
  let commandEnv = dataEnv;
  if (options.controlProxySocket) {
    if (!options.controlToken) throw new Error("a control-plane proxy requires a token");
    const controlPort = freePort(3129);
    forwards.push({ port: controlPort, socket: options.controlProxySocket });
    const credentials = `conveyor:${encodeURIComponent(options.controlToken)}`;
    const control = `http://${credentials}@127.0.0.1:${controlPort}`;
    commandEnv = {
      ...proxyEnvironment(control, loopbackService),
      HTTP_PROXY: "", http_proxy: "", ALL_PROXY: "", all_proxy: "",
      npm_config_proxy: "", npm_config_https_proxy: "",
    };
  }
  if (options.mcp) forwards.push({ port: options.mcp.port, socket: options.mcp.socket });
  if (options.localServices) forwards.push(...options.localServices);
  const spec = JSON.stringify({ forwards, command: options.argv });
  const allowedSockets = forwards.map((forward) => forward.socket);
  const filesystem = options.filesystem;
  if (filesystem) {
    const bubblewrap = findOnPath("bwrap", options.env.PATH);
    if (!bubblewrap) throw new Error("agent filesystem confinement requires bubblewrap");
    return {
      argv: [bubblewrap, "--unshare-net", "--unshare-pid", "--die-with-parent", ...filesystem.mounts, "--", process.execPath, "-e", BRIDGE_PROGRAM, spec],
      env: resolvePathEnvironment({ ...options.env, ...commandEnv }),
      dataEnv,
    };
  }
  return {
    argv: ["bwrap", "--unshare-net", "--unshare-pid", "--die-with-parent", "--dev-bind", "/", "/", ...isolationMounts(options.env.TMPDIR, allowedSockets), "--", ...selfCommand(INTERNAL.bridge, spec)],
    env: resolvePathEnvironment({ ...options.env, ...commandEnv }),
    dataEnv,
  };
}

// The egress bridge must run inside the network namespace, but mounting Conveyor's source tree to
// start it would reveal the service checkout to the agent.  Keep this tiny dependency-free bridge
// inline instead.
const BRIDGE_PROGRAM = `const net=require("node:net");const spec=JSON.parse(process.argv[1]);const forward=(e)=>new Promise((ok,no)=>{const s=net.createServer(c=>{const u=net.connect(e.socket);c.on("error",()=>u.destroy());u.on("error",()=>c.destroy());c.pipe(u);u.pipe(c);c.on("close",()=>u.destroy())});s.once("error",no);s.listen(e.port,"127.0.0.1",ok)});Promise.all(spec.forwards.map(forward)).then(()=>{const c=Bun.spawn(spec.command,{stdin:"inherit",stdout:"inherit",stderr:"inherit",env:process.env});for(const s of ["SIGTERM","SIGINT","SIGHUP"])process.on(s,()=>c.kill(s));return c.exited.then(x=>process.exit(c.signalCode?128+({SIGTERM:15,SIGINT:2,SIGHUP:1,SIGKILL:9}[c.signalCode]??1):x))}).catch(e=>{console.error("sandbox bridge failed: "+e.message);process.exit(125)})`;
