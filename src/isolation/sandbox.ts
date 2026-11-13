import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { resolveFilesystemPath, resolvePathEnvironment } from "../core/paths";
import { INTERNAL, selfCommand, sourceCheckoutRuntime } from "../self";
import { BUILD } from "../version";

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
  /**
   * The manifest file name that marks the harness's standalone release layout (see
   * `standaloneRelease`); absent: the executable is always mounted on its own.
   */
  releaseManifest?: string;
}

/** A prepared, narrow bubblewrap filesystem used by every agent harness. */
export interface AgentFilesystemPlan {
  mounts: string[];
}

/**
 * Builds the empty-root filesystem shared by every agent harness.  In particular this never
 * starts from a read-only host root: doing so makes hiding a few known secret directories a
 * blacklist with inevitable holes.
 */
export function agentFilesystemPlan(options: AgentFilesystemOptions): AgentFilesystemPlan {
  const workspace = requireDirectory(options.workspace, "workspace");
  const artifacts = requireDirectory(options.artifacts, "artifacts directory");
  const home = requireDirectory(options.home, "private home");
  const scratch = requireDirectory(options.scratch, "scratch directory");
  const executable = resolveCommand(options.command, options.env);
  if (!executable) throw new Error(`cannot confine a command that is not installed: ${options.command} (searched PATH: ${options.env.PATH ?? "unset"})`);

  const mounts = [
    "--tmpfs", "/",
    "--dir", "/usr",
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--dev", "/dev",
    "--proc", "/proc",
    // Many tools hard-code /tmp and ignore TMPDIR. A private tmpfs, mounted before the run's paths so a
    // run directory that lives under /tmp still layers on top of it, never exposes the host /tmp and
    // disappears with the namespace. The read-only root remount below leaves it writable.
    "--tmpfs", "/tmp",
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
  // The one exception is the executable itself when it sits in a standalone release layout.
  const release = options.releaseManifest ? standaloneRelease(executable, options.releaseManifest) : undefined;
  if (release) addPath(release, false, true);
  const interpreter = scriptInterpreter(executable, options.env);
  if (interpreter) addPath(interpreter, false);
  // A source install starts the run-scoped MCP server as `bun <checkout>/src/cli.ts __mcp`. Bun is
  // mounted above; the checkout's src/ and node_modules are mounted read-only here, and the rest of the
  // checkout (.git, service home, configuration) stays invisible. Compiled builds add nothing.
  for (const sourcePath of sourceCheckoutRuntime()) addPath(sourcePath, false);
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
  // Git replaces packed-refs by renaming packed-refs.lock over it, which a file bind mount cannot
  // survive and a read-only parent forbids. A writable agent therefore gets the common directory
  // itself, with everything but the ref stores (objects, refs, logs, packed-refs) hidden or read-only.
  // Only entries that exist can be masked, so a directory missing its hooks, info or config, or holding
  // a symlink, keeps today's read-only common directory rather than a writable one.
  const sharedGit = options.writableGit && git.commonDir && maskableCommonDirectory(git.commonDir) ? git.commonDir : undefined;
  if (sharedGit) {
    addPath(sharedGit, true, true);
    for (const entry of readdirSync(sharedGit, { withFileTypes: true })) {
      const target = path.join(sharedGit, entry.name);
      if (["objects", "refs", "logs", "packed-refs"].includes(entry.name)) continue;
      if (entry.name === "config") mounts.push("--ro-bind", target, target);
      else if (entry.name === "info") mounts.push("--ro-bind", target, target);
      else if (entry.isDirectory()) {
        // A scratch directory hides the contents (other runs' metadata, hooks); writes to it are lost.
        mounts.push("--tmpfs", target);
        if (entry.name !== "worktrees") mounts.push("--remount-ro", target);
      } else if (entry.isFile()) mounts.push("--ro-bind", "/dev/null", target);
    }
  }
  for (const gitPath of git.directories) addPath(gitPath, options.writableGit || writable.has(gitPath), true);
  // Packed refs, configuration and exclude rules resolve names like `main` and `origin/main`; they stay read-only.
  for (const gitFile of git.files) if (!sharedGit || !gitFile.startsWith(`${sharedGit}/`)) addPath(gitFile, false);
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
  // The root is a tmpfs created above: without this, a command could write anywhere in it. Binds
  // mounted over it keep their own access, so only the authorized write set stays writable.
  mounts.push("--remount-ro", "/");
  return { mounts };
}

/**
 * The installation root of a standalone agent release, when the resolved executable is
 * `<root>/bin/<name>` and `<root>/<manifest>` is a regular file. Some installers keep one release per
 * directory and the harness finds helpers and resources relative to its own resolved path, so those
 * siblings must exist. The harness plugin names its manifest (`releaseManifest`); the root itself is
 * recognised by that file, so it needs no configuration, and a plain single-file executable (no
 * manifest) keeps mounting only itself. Only this root is mounted, read-only: never the harness's
 * home, which holds credentials, nor other releases.
 */
function standaloneRelease(executable: string, manifest: string): string | undefined {
  const resolved = resolveFilesystemPath(executable);
  const binDirectory = path.dirname(resolved);
  if (path.basename(binDirectory) !== "bin") return undefined;
  const root = path.dirname(binDirectory);
  if (root === "/" || root === "/usr" || root.startsWith("/usr/")) return undefined;
  try {
    return statSync(path.join(root, manifest)).isFile() ? root : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The path to launch an agent by inside its confined filesystem. The plan mounts only the fully
 * resolved file, at its real path, so neither the `PATH` entry nor the intermediate symlinks of an
 * installer layout (`~/.local/bin/claude` -> `.../versions/<version>`) exist in the namespace. The
 * resolved path is launched instead of mounting the file under the symlink's name: the kernel reports
 * a running program's resolved path (`/proc/self/exe`) either way, so an agent that looks for files
 * relative to its own path sees the same real path as outside, and no directory holding the symlink
 * or the installation has to be exposed.
 */
export function agentLaunchCommand(options: Pick<AgentFilesystemOptions, "command" | "env">): string {
  const executable = resolveCommand(options.command, options.env);
  if (!executable) throw new Error(`cannot confine a command that is not installed: ${options.command} (searched PATH: ${options.env.PATH ?? "unset"}). Install it, or set the runner's command to an installed executable or an absolute path.`);
  return executable;
}

/** Starts an agent with its constrained filesystem, failing before the agent command can run. */
export function agentFilesystemCommand(options: AgentFilesystemOptions, argv: readonly string[]): SandboxedCommand {
  const plan = agentFilesystemPlan(options);
  const bubblewrap = findOnPath("bwrap", options.env.PATH);
  if (!bubblewrap) throw new Error("agent filesystem confinement requires bubblewrap on PATH; install it (for example: sudo apt install bubblewrap) and run `conveyor doctor`");
  const [command, ...rest] = argv;
  const launched = command === options.command ? agentLaunchCommand(options) : command;
  return { argv: [bubblewrap, "--unshare-pid", "--die-with-parent", ...plan.mounts, "--", ...(launched === undefined ? [] : [launched]), ...rest], env: resolvePathEnvironment(options.env), dataEnv: {} };
}

/**
 * Proves the namespace in a wrapped launch can be created before the agent command is started, by
 * running the same bubblewrap arguments around a no-op. Fails closed with an actionable message.
 */
export function verifyAgentWrapper(launch: Pick<SandboxedCommand, "argv" | "env">, command?: string): void {
  const separator = launch.argv.indexOf("--");
  if (separator < 0) throw new Error("agent filesystem wrapper has no command separator");
  let probe: ReturnType<typeof Bun.spawnSync>;
  try {
    probe = Bun.spawnSync([...launch.argv.slice(0, separator + 1), "/usr/bin/true"], { env: launch.env, stdout: "ignore", stderr: "pipe" });
  } catch (error) {
    throw new Error(`Cannot establish the agent filesystem wrapper: bubblewrap could not be started (${error instanceof Error ? error.message : String(error)}). Install bubblewrap and run \`conveyor doctor\`.`, { cause: error });
  }
  if (probe.exitCode !== 0) {
    throw new Error(`Cannot establish the agent filesystem wrapper; no agent command was started. bubblewrap failed: ${probe.stderr?.toString().trim() || `exit ${probe.exitCode}`}. Allow unprivileged user, network and mount namespaces for bwrap and run \`conveyor doctor\`.`);
  }
  if (command === undefined) return;
  const present = Bun.spawnSync([...launch.argv.slice(0, separator + 1), "/usr/bin/test", "-x", command], { env: launch.env, stdout: "ignore", stderr: "ignore" });
  if (present.exitCode !== 0) {
    throw new Error(`Agent command ${command} cannot be found inside the confined filesystem; no agent command was started. Set the runner's command to an installed executable (or its absolute path) that the service account can run, and run \`conveyor doctor\`.`);
  }
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

function maskableCommonDirectory(commonDir: string): boolean {
  try {
    const entries = readdirSync(commonDir, { withFileTypes: true });
    const names = new Set(entries.map((entry) => entry.name));
    if (!["hooks", "info", "config"].every((name) => names.has(name))) return false;
    return entries.every((entry) => entry.isDirectory() || entry.isFile());
  } catch {
    return false;
  }
}

function linkedGitPaths(workspace: string): { directories: string[]; files: string[]; commonDir?: string } {
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
      commonDir,
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
    if (!bubblewrap) throw new Error("agent filesystem confinement requires bubblewrap on PATH; install it (for example: sudo apt install bubblewrap) and run `conveyor doctor`");
    return {
      argv: [bubblewrap, "--unshare-net", "--unshare-pid", "--die-with-parent", ...filesystem.mounts, "--", ...confinedBridgeCommand(spec)],
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

/**
 * The bridge command inside the confined filesystem. A compiled build runs its own executable's
 * `__bridge` (the executable is mounted read-only; no source checkout exists). From a source checkout
 * the inline program keeps the checkout unmounted and hidden from the agent.
 */
function confinedBridgeCommand(spec: string): string[] {
  return BUILD.compiled ? [process.execPath, INTERNAL.bridge, spec] : [process.execPath, "-e", BRIDGE_PROGRAM, spec];
}

// The egress bridge must run inside the network namespace, but mounting Conveyor's source tree to
// start it would reveal the service checkout to the agent.  Keep this tiny dependency-free bridge
// inline instead.
const BRIDGE_PROGRAM = `const net=require("node:net");const spec=JSON.parse(process.argv[1]);const forward=(e)=>new Promise((ok,no)=>{const s=net.createServer(c=>{const u=net.connect(e.socket);c.on("error",()=>u.destroy());u.on("error",()=>c.destroy());c.pipe(u);u.pipe(c);c.on("close",()=>u.destroy())});s.once("error",no);s.listen(e.port,"127.0.0.1",ok)});Promise.all(spec.forwards.map(forward)).then(()=>{const c=Bun.spawn(spec.command,{stdin:"inherit",stdout:"inherit",stderr:"inherit",env:process.env});for(const s of ["SIGTERM","SIGINT","SIGHUP"])process.on(s,()=>c.kill(s));return c.exited.then(x=>process.exit(c.signalCode?128+({SIGTERM:15,SIGINT:2,SIGHUP:1,SIGKILL:9}[c.signalCode]??1):x))}).catch(e=>{console.error("sandbox bridge failed: "+e.message);process.exit(125)})`;
