import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { startEgressProxy, type EgressProxy } from "../../src/isolation/egress-proxy";
import { prepareCodexEnvironment } from "../../src/isolation/environment";
import { serveMcpSocket } from "../../src/isolation/mcp-socket";
import { confinedCommand, confinedCommandPlan, privateTmpCommand, sandboxCommand } from "../../src/isolation/sandbox";
import { bwrapUnavailableReason } from "../support/bwrap";
import { shortTemporaryDirectory } from "../support/short-temporary-directory";

const unavailable = bwrapUnavailableReason();
const describeSandbox = unavailable ? describe.skip : describe;
if (unavailable) console.warn(`SKIPPED sandbox tests: \`bwrap --unshare-net\` is unavailable (${unavailable})`);

test("private-tmp command mounts an isolated /tmp", () => {
  const launch = privateTmpCommand({ argv: ["codex", "exec"], env: { PATH: "/usr/bin" } });
  expect(launch.argv.slice(0, 5)).toEqual(["bwrap", "--die-with-parent", "--dev-bind", "/", "/"]);
  expect(launch.argv.join(" ")).toContain("--tmpfs /tmp");
  expect(launch.argv.slice(-3)).toEqual(["--", "codex", "exec"]);
});

test("SPEC documents default denial of host path-based sockets for egress runs", async () => {
  const specification = await readFile(path.join(import.meta.dir, "../../SPEC.md"), "utf8");
  expect(specification).toContain("Host path-based Unix sockets are denied by default");
  expect(specification).toContain("The only retained sockets are the data-plane, control-plane, MCP, and repository-declared local-service endpoints explicitly forwarded for that run");
  expect(specification).toContain("The masks cover filesystem sockets active in the host network namespace when the wrapper is built");
  expect(specification).toContain("Sockets created later, or bound in other network namespaces, remain reachable until filesystem confinement (#399) lands");
});

test("architecture documents the socket-denial residual risk", async () => {
  const architecture = await readFile(path.join(import.meta.dir, "../../docs/architecture.md"), "utf8");
  expect(architecture).toContain("The masks cover filesystem sockets active in the host network namespace when the wrapper is built");
  expect(architecture).toContain("Sockets created later, or bound in other network namespaces, remain reachable until filesystem confinement (#399) lands");
});

describeSandbox("confined command exposes only its fresh scratch directory", () => {
  test("denies an agent read of another Conveyor home's database", async () => {
    const root = await shortTemporaryDirectory("conveyor-operator-confined-");
    try {
      const scratch = path.join(root, "scratch");
      const otherHome = path.join(root, "another-conveyor-home");
      const database = path.join(otherHome, "conveyor.sqlite");
      const runtime = path.join(root, "codex-runtime");
      const agent = path.join(runtime, "codex");
      const mcpRuntime = path.join(root, "mcp-runtime");
      const mcp = path.join(mcpRuntime, "bridge");
      const mcpContext = path.join(root, "mcp-context.json");
      const codexHome = path.join(root, "codex-home");
      await mkdir(scratch);
      await mkdir(otherHome);
      await mkdir(runtime);
      await mkdir(mcpRuntime);
      await mkdir(codexHome);
      await writeFile(database, "database that must not be readable");
      await writeFile(path.join(runtime, "runtime-dependency"), "codex-runtime");
      await writeFile(path.join(mcpRuntime, "runtime-dependency"), "mcp-runtime");
      await writeFile(path.join(codexHome, "auth.json"), "credential");
      await writeFile(mcpContext, "mcp-context");
      await writeFile(mcp, `#!/bin/sh
      test "$(cat "$(dirname "$0")/runtime-dependency")" = mcp-runtime || exit 21
      test "$(cat "$MCP_CONTEXT")" = mcp-context || exit 22
      printf mcp-ready
    `);
      await writeFile(agent, `#!/bin/sh
      test -z "$(ls -A \"$TMPDIR\")" || exit 11
      if cat "$HOST_DATABASE" >/dev/null 2>&1; then exit 12; fi
      test "$(cat "$CODEX_HOME/auth.json")" = credential || exit 13
      test "$(cat "$(dirname "$0")/runtime-dependency")" = codex-runtime || exit 14
      test -r /etc/resolv.conf || exit 15
      test -d /etc/ssl/certs || exit 16
      test "$("$MCP_COMMAND")" = mcp-ready || exit 17
      printf usable > "$TMPDIR/operator-file"
    `);
      await Promise.all([chmod(agent, 0o755), chmod(mcp, 0o755)]);
      const launch = confinedCommand({
        argv: [agent],
        env: {
          PATH: "/usr/bin:/bin",
          HOST_DATABASE: database,
          CODEX_HOME: codexHome,
          MCP_COMMAND: mcp,
          MCP_CONTEXT: mcpContext,
        },
        scratch,
        readablePaths: [mcpContext],
        runtimePaths: [mcp],
      });
      expect(await readdir(scratch)).toEqual([]);
      const child = Bun.spawn(launch.argv, { env: launch.env, stdout: "pipe", stderr: "pipe" });
      expect(await child.exited).toBe(0);
      expect(await Bun.file(path.join(scratch, "operator-file")).text()).toBe("usable");
      expect(await Bun.file(database).text()).toBe("database that must not be readable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("confined command fails closed before bubblewrap can launch", async () => {
  const root = await shortTemporaryDirectory("conveyor-confined-plan-");
  try {
    const scratch = path.join(root, "scratch");
    const runtime = path.join(root, "runtime");
    const command = path.join(runtime, "codex");
    const codexHome = path.join(root, "codex-home");
    await Promise.all([mkdir(scratch), mkdir(runtime), mkdir(codexHome)]);
    await writeFile(command, "#!/bin/sh\nexit 0\n");
    await chmod(command, 0o755);
    await writeFile(path.join(codexHome, "auth.json"), "credential");

    const plan = confinedCommandPlan({ argv: [command], env: { PATH: "/usr/bin", CODEX_HOME: codexHome }, scratch });
    expect(plan.argv).not.toContain("--dev-bind");
    expect(plan.argv.filter((argument) => argument === "--bind")).toEqual(["--bind"]);
    expect(plan.argv.slice(plan.argv.indexOf("--bind"), plan.argv.indexOf("--bind") + 3)).toEqual(["--bind", scratch, scratch]);
    expect(plan.env.HOME).toBe(scratch);
    expect(plan.env.CODEX_HOME).toBe(codexHome);
    expect(() => confinedCommand({ argv: [command], env: { PATH: "", CODEX_HOME: codexHome }, scratch })).toThrow("requires bubblewrap");
    expect(() => confinedCommand({ argv: [command], env: { PATH: "/usr/bin" }, scratch })).toThrow("requires CODEX_HOME/auth.json");
    expect(() => confinedCommand({ argv: [command], env: { PATH: "/usr/bin", CODEX_HOME: codexHome }, scratch: path.join(root, "missing") })).toThrow("scratch directory does not exist");
    expect(() => confinedCommand({ argv: ["missing-codex"], env: { PATH: "/usr/bin", CODEX_HOME: codexHome }, scratch })).toThrow("not installed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("network isolation normalizes a symlinked run temporary directory", async () => {
  const root = await shortTemporaryDirectory("conveyor-isolation-paths-");
  const target = path.join(root, "target");
  const link = path.join(root, "link");
  const runTmp = path.join(target, "run-tmp");
  try {
    await mkdir(runTmp, { recursive: true });
    await symlink(target, link);
    const launch = sandboxCommand({
      argv: ["echo", "x"],
      env: { TMPDIR: path.join(link, "run-tmp") },
      dataProxySocket: "/tmp/conveyor-proxy.sock",
    });
    const command = launch.argv.join(" ");
    expect(command).not.toContain(link);
    if (runTmp.startsWith("/tmp/")) expect(command).toContain(`--bind ${runTmp} ${runTmp}`);
    else expect(command).not.toContain(`--bind ${runTmp} ${runTmp}`);
    expect(launch.env.TMPDIR).toBe(runTmp);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("network isolation masks an undeclared active host Unix socket in its launch plan", async () => {
  const root = await shortTemporaryDirectory("conveyor-plan-socket-", { socketPath: "host.sock", visibleInSandbox: true });
  const socket = path.join(root, "host.sock");
  const server = await listenUnixSocket(socket);
  try {
    const launch = sandboxCommand({ argv: ["echo", "x"], env: { PATH: process.env.PATH ?? "" }, dataProxySocket: "/tmp/conveyor-proxy.sock" });
    expect(launch.argv).toContain("--ro-bind");
    expect(launch.argv.join("\u0000")).toContain(`--ro-bind\u0000/dev/null\u0000${socket}`);
  } finally {
    await closeServer(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("network isolation retains explicitly forwarded proxy and MCP sockets in its launch plan", async () => {
  const root = await shortTemporaryDirectory("conveyor-forward-sockets-", { socketPath: "data.sock", visibleInSandbox: true });
  const dataSocket = path.join(root, "data.sock");
  const mcpSocket = path.join(root, "mcp.sock");
  const postgresSocket = path.join(root, "postgres.sock");
  const [dataServer, mcpServer, postgresServer] = await Promise.all([
    listenUnixSocket(dataSocket),
    listenUnixSocket(mcpSocket),
    listenUnixSocket(postgresSocket),
  ]);
  try {
    const launch = sandboxCommand({
      argv: ["echo", "x"],
      env: { PATH: process.env.PATH ?? "" },
      dataProxySocket: dataSocket,
      localServices: [{ port: 54_321, socket: postgresSocket }],
      mcp: { port: 41_234, socket: mcpSocket },
    });
    const mounts = launch.argv.join("\u0000");
    expect(mounts).not.toContain(`--ro-bind\u0000/dev/null\u0000${dataSocket}`);
    expect(mounts).not.toContain(`--ro-bind\u0000/dev/null\u0000${mcpSocket}`);
    expect(mounts).not.toContain(`--ro-bind\u0000/dev/null\u0000${postgresSocket}`);
    expect(launch.dataEnv.NO_PROXY).toBe("127.0.0.1");
  } finally {
    await Promise.all([
      closeServer(dataServer),
      closeServer(mcpServer),
      closeServer(postgresServer),
    ]);
    await rm(root, { recursive: true, force: true });
  }
});

const TOKEN = "per-run-token-1234";
const PROBES = `
import net from "node:net";
const timeout = (ms) => new Promise((resolve) => { const timer = setTimeout(() => resolve({ error: "timeout" }), ms); timer.unref(); });
export function via(proxyUrl, host) {

  const url = new URL(proxyUrl);
  const attempt = new Promise((resolve) => {
    const socket = net.connect(Number(url.port), url.hostname);
    let raw = "";
    socket.on("error", (error) => resolve({ error: error.code ?? String(error) }));
    socket.on("data", (chunk) => {
      raw += chunk.toString();
      if (raw.startsWith("HTTP/1.1 200") && !raw.includes("pong:")) return socket.write("ping");
      if (raw.includes("pong:")) { socket.destroy(); return resolve({ status: 200, echo: raw.split("\\r\\n\\r\\n")[1] }); }
      if (raw.includes("\\r\\n\\r\\n")) { socket.destroy(); resolve({ status: Number(raw.split(" ")[1]) }); }
    });
    const auth = url.username ? "Proxy-Authorization: Basic " + Buffer.from(url.username + ":" + url.password).toString("base64") + "\\r\\n" : "";
    socket.write("CONNECT " + host + ":443 HTTP/1.1\\r\\nHost: " + host + ":443\\r\\n" + auth + "\\r\\n");
  });
  return Promise.race([attempt, timeout(3000)]);
}
export function direct(host, port) {
  const attempt = new Promise((resolve) => {
    const socket = net.connect(port, host);
    socket.on("connect", () => { socket.destroy(); resolve({ connected: true }); });
    socket.on("error", (error) => resolve({ error: error.code ?? String(error) }));
  });
  return Promise.race([attempt, timeout(3000)]);
}
`;

const HARNESS = `
import { via, direct } from "./probes.ts";
const mode = process.argv[2];
const own = process.env.HTTPS_PROXY;
if (mode === "child") {
  const proxy = process.env.HTTPS_PROXY;
  const out = {
    model: await via(proxy, "model.fake.test"),
    github: await via(proxy, "api.github.com"),
    registry: await via(proxy, "registry.fake.test"),
    directAddress: await direct("203.0.113.2", 443),
    directHost: await direct("127.0.0.1", Number(process.env.DIRECT_PORT)),
    credentialNames: Object.keys(process.env).filter((name) => /TOKEN|SECRET|PASSWORD|^GH_|CREDENTIAL/i.test(name)),
    leaksToken: Object.values(process.env).some((value) => String(value).includes(process.env.RUN_TOKEN ?? "no-token")),
    proxyUrl: proxy,
  };
  console.log(JSON.stringify(out));
} else {
  const noAuth = new URL(own); noAuth.username = ""; noAuth.password = "";
  const childEnv = JSON.parse(process.env.CHILD_ENV);
  const child = Bun.spawnSync([process.execPath, import.meta.path, "child"], { env: childEnv, stdout: "pipe" });
  console.log(JSON.stringify({
    model: await via(own, "model.fake.test"),
    modelWithoutToken: await via(noAuth.toString(), "model.fake.test"),
    githubViaControl: await via(own, "api.github.com"),
    registryViaControl: await via(own, "registry.fake.test"),
    directAddress: await direct("203.0.113.1", 443),
    child: JSON.parse(child.stdout.toString()),
  }));
}
`;

let directory: string;
let data: EgressProxy;
let control: EgressProxy;
let upstreams: net.Server[] = [];
let hostEchoPort = 0;

async function echo(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => socket.write(`pong:${chunk}`));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  upstreams.push(server);
  return { server, port: (server.address() as net.AddressInfo).port };
}

async function listenUnixSocket(socket: string): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve());
  });
  return server;
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function sandboxSocketProbe(socketPath: string): Promise<string> {
  const sandboxed = sandboxCommand({
    argv: [process.execPath, "-e", `
      const net = require("node:net");
      const socket = net.connect(process.argv[1]);
      const done = (result) => { console.log(result); process.exit(0); };
      const timeout = setTimeout(() => done("timeout"), 1000);
      socket.on("connect", () => { clearTimeout(timeout); socket.destroy(); done("connected"); });
      socket.on("error", () => { clearTimeout(timeout); done("denied"); });
    `, socketPath],
    env: { PATH: process.env.PATH ?? "" },
    dataProxySocket: data.socketPath,
  });
  const child = Bun.spawn(sandboxed.argv, { env: sandboxed.env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`socket probe exited ${code}: ${err}`);
  return out.trim();
}

async function sandboxServiceProbe(port: number, localServices: readonly { port: number; socket: string }[] = []): Promise<string> {
  const sandboxed = sandboxCommand({
    argv: [process.execPath, "-e", `
      const net = require("node:net");
      const socket = net.connect(Number(process.argv[1]), "127.0.0.1");
      const done = (result) => { console.log(result); process.exit(0); };
      const timeout = setTimeout(() => done("timeout"), 1000);
      socket.on("connect", () => socket.write("ping"));
      socket.on("data", (chunk) => { clearTimeout(timeout); socket.destroy(); done(chunk.toString()); });
      socket.on("error", () => { clearTimeout(timeout); done("denied"); });
    `, String(port)],
    env: { PATH: process.env.PATH ?? "" },
    dataProxySocket: data.socketPath,
    ...(localServices.length > 0 ? { localServices } : {}),
  });
  const child = Bun.spawn(sandboxed.argv, { env: sandboxed.env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`service probe exited ${code}: ${err}`);
  return out.trim();
}

beforeAll(async () => {
  if (unavailable) return;
  directory = await shortTemporaryDirectory("conveyor-sbx-", {
    socketPath: "control.sock",
    visibleInSandbox: true,
  });
  await writeFile(path.join(directory, "probes.ts"), PROBES);
  await writeFile(path.join(directory, "harness.ts"), HARNESS);
  const model = await echo();
  const registry = await echo();
  hostEchoPort = (await echo()).port;
  const addresses: Record<string, string> = {
    "model.fake.test": "203.0.113.1",
    "registry.fake.test": "203.0.113.2",
    "api.github.com": "203.0.113.3",
  };
  const targets: Record<string, number> = { "203.0.113.1": model.port, "203.0.113.2": registry.port };
  const shared = {
    resolve: async (host: string) => (addresses[host] ? [addresses[host]!] : []),
    dial: (address: string) => net.connect(targets[address] ?? 1, "127.0.0.1"),
  };
  data = await startEgressProxy({ socketPath: path.join(directory, "d.sock"), allowedHosts: ["registry.fake.test"], ...shared });
  control = await startEgressProxy({ socketPath: path.join(directory, "c.sock"), allowedHosts: ["model.fake.test"], token: TOKEN, ...shared });
});

afterAll(async () => {
  if (unavailable) return;
  await data.close();
  await control.close();
  for (const server of upstreams) server.close();
  await rm(directory, { recursive: true, force: true });
});

async function runHarness(access: "read-only" | "workspace-write"): Promise<any> {
  const parent = { PATH: process.env.PATH, HOME: process.env.HOME, GH_TOKEN: "ghp_secret", GITHUB_TOKEN: "ghs_secret", HTTPS_PROXY: "http://u:p@corp:3128" };
  const env = await prepareCodexEnvironment({
    artifactsDirectory: path.join(directory, `run-${access}`),
    workspace: directory,
    parent,
    overrides: { RUN_TOKEN: TOKEN, ACCESS: access } as never,
  });
  const sandboxed = sandboxCommand({
    argv: [process.execPath, path.join(directory, "harness.ts")],
    env,
    dataProxySocket: data.socketPath,
    controlProxySocket: control.socketPath,
    controlToken: TOKEN,
  });
  const childEnv = { PATH: env.PATH ?? "", HOME: env.HOME ?? "", ...sandboxed.dataEnv, DIRECT_PORT: String(hostEchoPort) };
  const child = Bun.spawn(sandboxed.argv, { env: { ...sandboxed.env, CHILD_ENV: JSON.stringify(childEnv) }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`harness exited ${code}: ${err}`);
  return JSON.parse(out);
}

describeSandbox("sandboxCommand (bwrap --unshare-net)", () => {
  setDefaultTimeout(30_000);
  test("argv wraps the bridge in a fresh network namespace", () => {
    const sandboxed = sandboxCommand({ argv: ["echo", "x"], env: { PATH: "/usr/bin" }, dataProxySocket: "/tmp/d.sock" });
    expect(sandboxed.argv.slice(0, 7)).toEqual(["bwrap", "--unshare-net", "--unshare-pid", "--die-with-parent", "--dev-bind", "/", "/"]);
    expect(sandboxed.argv).toContain("--proc");
    expect(sandboxed.argv.join(" ")).toContain("--tmpfs /tmp");
    expect(sandboxed.argv).toContain("--");
  });

  test("a run's temp directory under /tmp stays visible behind the private /tmp", async () => {
    const runTmp = await mkdtemp("/tmp/conveyor-run-");
    try {
      const argv = (env: Record<string, string>) => sandboxCommand({ argv: ["echo", "x"], env, dataProxySocket: "/tmp/d.sock" }).argv.join(" ");
      expect(argv({ TMPDIR: runTmp })).toContain(`--tmpfs /tmp --bind ${runTmp} ${runTmp}`);
      expect(argv({ TMPDIR: "/var/tmp" })).not.toContain("--bind");
      expect(argv({ TMPDIR: "/tmp/conveyor-run-missing" })).not.toContain("--bind");
    } finally {
      await rm(runTmp, { recursive: true, force: true });
    }
  });

  test("a private-tmp launch cannot persist a host /tmp write", async () => {
    const marker = `/tmp/conveyor-private-tmp-${process.pid}-${Date.now()}`;
    const sandboxed = privateTmpCommand({
      argv: ["sh", "-c", `test ! -e ${marker}; echo private > ${marker}; test -e ${marker}`],
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(await Bun.spawn(sandboxed.argv, { env: sandboxed.env }).exited).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test.each(["read-only", "workspace-write"] as const)(
    "harness reaches the model host only through the token proxy; its commands cannot (%s)",
    async (access) => {
      const result = await runHarness(access);
      expect(result.model).toEqual({ status: 200, echo: "pong:ping" });
      expect(result.modelWithoutToken).toEqual({ status: 407 });
      expect(result.githubViaControl).toEqual({ status: 403 });
      expect(result.registryViaControl).toEqual({ status: 403 });
      expect(result.directAddress.connected).toBeUndefined();
      expect(result.directAddress.error).toMatch(/^E(CONNREFUSED|NETUNREACH)$/);
      expect(result.child.model).toEqual({ status: 403 });
      expect(result.child.github).toEqual({ status: 403 });
      expect(result.child.registry).toEqual({ status: 200, echo: "pong:ping" });
      expect(result.child.directAddress.error).toMatch(/^E(CONNREFUSED|NETUNREACH)$/);
      expect(result.child.directHost.error).toMatch(/^E(CONNREFUSED|NETUNREACH)$/);
      expect(result.child.credentialNames).toEqual([]);
      expect(result.child.leaksToken).toBe(false);
      expect(result.child.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    },
  );

  test("both access levels see identical network behaviour", async () => {
    const [readOnly, writable] = await Promise.all([runHarness("read-only"), runHarness("workspace-write")]);
    expect(writable.child).toEqual(readOnly.child);
  });

  test("the namespace has a working loopback and no host services", async () => {
    const sandboxed = sandboxCommand({
      argv: [process.execPath, "-e", `
        const net = require("node:net");
        const s = net.connect(${hostEchoPort}, "127.0.0.1");
        s.on("connect", () => { console.log("reached"); process.exit(0); });
        s.on("error", (e) => { console.log(e.code); process.exit(0); });`],
      env: { PATH: process.env.PATH ?? "" },
      dataProxySocket: data.socketPath,
    });
    const child = Bun.spawn(sandboxed.argv, { env: sandboxed.env, stdout: "pipe" });
    expect((await new Response(child.stdout).text()).trim()).toBe("ECONNREFUSED");
  });

  test("forwards a declared Unix service only into the sandbox that declares it", async () => {
    const root = await shortTemporaryDirectory("conveyor-local-service-", { socketPath: "postgres.sock", visibleInSandbox: true });
    const socket = path.join(root, "postgres.sock");
    const port = 45_432;
    const service = net.createServer((connection) => connection.on("data", (chunk) => connection.write(`postgres:${chunk}`)));
    await new Promise<void>((resolve, reject) => {
      service.once("error", reject);
      service.listen(socket, () => resolve());
    });
    try {
      expect(await sandboxServiceProbe(port, [{ port, socket }])).toBe("postgres:ping");
      expect(await sandboxServiceProbe(port)).toBe("denied");
    } finally {
      await closeServer(service);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("propagates the wrapped command's exit code", async () => {
    const sandboxed = sandboxCommand({ argv: ["sh", "-c", "exit 7"], env: { PATH: process.env.PATH ?? "" }, dataProxySocket: data.socketPath });
    expect(await Bun.spawn(sandboxed.argv, { env: sandboxed.env }).exited).toBe(7);
  });

  const pgrep = (pattern: string): boolean => Bun.spawnSync(["pgrep", "-f", pattern]).exitCode === 0;

  test.each(["SIGTERM", "SIGKILL"] as const)("%s to the wrapper leaves no wrapped grandchild running", async (signal) => {
    const marker = signal === "SIGTERM" ? "sleep 41" : "sleep 42";
    const sandboxed = sandboxCommand({ argv: ["sh", "-c", `${marker} & wait`], env: { PATH: process.env.PATH ?? "" }, dataProxySocket: data.socketPath });
    const child = Bun.spawn(sandboxed.argv, { env: sandboxed.env });
    for (let i = 0; i < 50 && !pgrep(marker); i++) await Bun.sleep(100);
    expect(pgrep(marker)).toBe(true);
    child.kill(signal);
    await child.exited;
    for (let i = 0; i < 50 && pgrep(marker); i++) await Bun.sleep(100);
    expect(pgrep(marker)).toBe(false);
  });

  test("host sockets under /tmp are not visible inside the sandbox", async () => {
    const hostSocket = path.join("/tmp", `conveyor-sbx-${process.pid}.sock`);
    const server = net.createServer().listen(hostSocket);
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const sandboxed = sandboxCommand({ argv: ["sh", "-c", `test -e ${hostSocket} && echo visible || echo hidden`], env: { PATH: process.env.PATH ?? "" }, dataProxySocket: data.socketPath });
      const child = Bun.spawn(sandboxed.argv, { env: sandboxed.env, stdout: "pipe" });
      expect((await new Response(child.stdout).text()).trim()).toBe("hidden");
    } finally {
      server.close();
    }
  });

  test("denies an undeclared host Unix socket outside the temporary-directory masks", async () => {
    const root = await shortTemporaryDirectory("conveyor-host-socket-", { socketPath: "host.sock", visibleInSandbox: true });
    const socket = path.join(root, "host.sock");
    const server = await listenUnixSocket(socket);
    try {
      expect(await sandboxSocketProbe(socket)).toBe("denied");
    } finally {
      await closeServer(server);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denies a symlink to an undeclared host Unix socket", async () => {
    const root = await shortTemporaryDirectory("conveyor-host-symlink-", { socketPath: "target.sock", visibleInSandbox: true });
    const socket = path.join(root, "target.sock");
    const link = path.join(root, "link.sock");
    const server = await listenUnixSocket(socket);
    try {
      await symlink(socket, link);
      expect(await sandboxSocketProbe(link)).toBe("denied");
    } finally {
      await closeServer(server);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denies the host Docker socket when present", async () => {
    const dockerSocket = ["/var/run/docker.sock", "/run/docker.sock"].find((socket) => {
      try {
        return statSync(socket).isSocket();
      } catch {
        return false;
      }
    });
    if (!dockerSocket) return;
    expect(await sandboxSocketProbe(dockerSocket)).toBe("denied");
  });

  test("host processes are not visible inside the sandbox", async () => {
    const sandboxed = sandboxCommand({ argv: ["sh", "-c", "ls /proc | grep -c '^[0-9]'"], env: { PATH: process.env.PATH ?? "" }, dataProxySocket: data.socketPath });
    const child = Bun.spawn(sandboxed.argv, { env: sandboxed.env, stdout: "pipe" });
    expect(Number((await new Response(child.stdout).text()).trim())).toBeLessThan(20);
  });

  test("MCP forward exposes only the service's MCP endpoint on the exact port", async () => {
    const socket = path.join(directory, "mcp.sock");
    const server = serveMcpSocket({
      socket,
      handler: async (request) => new Response(JSON.stringify({ path: new URL(request.url).pathname }), { headers: { "content-type": "application/json" } }),
    });
    try {
      const probe = await Bun.serve({ port: 0, fetch: () => new Response("x") });
      const otherPort = probe.port ?? 45_000;
      await probe.stop(true);
      const mcpPort = otherPort + 1 > 65_000 ? otherPort - 1 : otherPort + 1;
      const sandboxed = sandboxCommand({
        argv: [process.execPath, "-e", `
          const base = "http://127.0.0.1:${mcpPort}";
          const mcp = await (await fetch(base + "/internal/mcp", { method: "POST", body: "{}" })).json();
          const other = (await fetch(base + "/internal/other")).status;
          const elsewhere = await fetch("http://127.0.0.1:${otherPort}/").then(() => "reached", (e) => "refused");
          console.log(JSON.stringify({ mcp, other, elsewhere }));`],
        env: { PATH: process.env.PATH ?? "" },
        dataProxySocket: data.socketPath,
        mcp: { port: mcpPort, socket },
      });
      const child = Bun.spawn(sandboxed.argv, { env: sandboxed.env, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(child.stdout).text();
      if (!out) throw new Error(await new Response(child.stderr).text());
      expect(JSON.parse(out)).toEqual({ mcp: { path: "/internal/mcp" }, other: 404, elsewhere: "refused" });
    } finally {
      await server.stop(true);
    }
  });
});
