import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";

import { startEgressProxy, type EgressProxy } from "../../src/isolation/egress-proxy";
import { prepareCodexEnvironment } from "../../src/isolation/environment";
import { serveMcpSocket } from "../../src/isolation/mcp-socket";
import { sandboxCommand } from "../../src/isolation/sandbox";
import { bwrapUnavailableReason } from "../support/bwrap";

const unavailable = bwrapUnavailableReason();
const describeSandbox = unavailable ? describe.skip : describe;
if (unavailable) console.warn(`SKIPPED sandbox tests: \`bwrap --unshare-net\` is unavailable (${unavailable})`);

const SCRATCH = path.join(homedir(), ".cache", "conveyor-test");
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

beforeAll(async () => {
  if (unavailable) return;
  // Not under /tmp: the sandbox mounts a private /tmp.
  await mkdir(SCRATCH, { recursive: true });
  directory = await mkdtemp(path.join(SCRATCH, "sbx-"));
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
