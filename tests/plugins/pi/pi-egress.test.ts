// pi under agentEgress with a real bwrap: the pi process reaches only its control-plane hosts through
// the token-protected proxy, while its bash commands (run as pi runs them: `<shellPath> -c
// "<shellCommandPrefix>\n<command>"`) and its MCP servers (started as pi starts them: no shell, pi's own
// environment) get only the data-plane proxy, without pi's agent directory or credentials.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { runPi } from "../../../src/plugins/pi/pi";
import { bwrapUnavailableReason } from "../../support/bwrap";
import { VALID_RESULT, installFakePi } from "../../support/fake-pi";
import { shortTemporaryDirectory } from "../../support/short-temporary-directory";

const unavailable = bwrapUnavailableReason();
if (unavailable) console.warn(`SKIPPED pi egress tests: \`bwrap --unshare-net\` is unavailable (${unavailable})`);
const describeSandbox = unavailable ? describe.skip : describe;

const directories: string[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

// What a command or MCP server sees: its proxy, pi's variables, and where its proxy lets it connect.
const PROBE = `
const net = require("node:net");
const connect = (proxy, host) => new Promise((resolve) => {
  const url = new URL(proxy);
  const socket = net.connect(Number(url.port), url.hostname);
  let raw = "";
  socket.on("error", (e) => resolve(e.code));
  socket.on("data", (c) => { raw += c; if (raw.includes("\\r\\n\\r\\n")) { socket.destroy(); resolve(raw.split(" ")[1]); } });
  socket.write("CONNECT " + host + ":443 HTTP/1.1\\r\\nHost: " + host + ":443\\r\\n\\r\\n");
});
const direct = (address) => new Promise((resolve) => {
  const socket = net.connect({ host: address, port: 443, timeout: 1500 });
  socket.on("connect", () => { socket.destroy(); resolve("connected"); });
  socket.on("timeout", () => { socket.destroy(); resolve("timeout"); });
  socket.on("error", (e) => resolve(e.code));
});
const loopback = (port) => new Promise((resolve) => {
  const socket = net.connect(port, "127.0.0.1");
  let data = "";
  socket.on("error", (e) => resolve(e.code));
  socket.on("data", (c) => { data += c; });
  socket.on("close", () => resolve(data));
});
const proxy = process.env.HTTPS_PROXY;
(async () => {
  const result = {
    proxy, agentDir: process.env.PI_CODING_AGENT_DIR ?? null, credential: process.env.EXAMPLE_API_KEY ?? null,
    allowed: await connect(proxy, "registry.fake.test"),
    model: await connect(proxy, "model.fake.test"),
    unlisted: await connect(proxy, "other.fake.test"),
    github: await connect(proxy, "api.github.com"),
    ipLiteral: await connect(proxy, "203.0.113.9"),
    directIp: await direct("203.0.113.9"),
    mcp: process.env.MCP_PORT ? await loopback(Number(process.env.MCP_PORT)) : null,
    hostLoopback: await loopback(Number(process.env.HOST_PORT)),
  };
  console.log(JSON.stringify(result));
})();
`;

const FAKE_PI = `
import net from "node:net";
import { readFileSync } from "node:fs";
const agentDir = process.env.PI_CODING_AGENT_DIR;
const settings = JSON.parse(readFileSync(agentDir + "/settings.json", "utf8"));
const mcp = JSON.parse(readFileSync(agentDir + "/mcp.json", "utf8"));
await Bun.stdin.text();
const proxy = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null;
const connect = (host) => new Promise((resolve) => {
  const socket = net.connect(Number(proxy.port), proxy.hostname);
  let raw = "";
  socket.on("error", (e) => resolve(e.code));
  socket.on("data", (c) => { raw += c; if (raw.includes("\\r\\n\\r\\n")) { socket.destroy(); resolve(raw.split(" ")[1]); } });
  const auth = Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64");
  socket.write("CONNECT " + host + ":443 HTTP/1.1\\r\\nHost: " + host + ":443\\r\\nProxy-Authorization: Basic " + auth + "\\r\\n\\r\\n");
});
const text = (bytes) => new TextDecoder().decode(bytes);
const capture = { args: process.argv.slice(2), proxy: process.env.HTTPS_PROXY, settings, credential: process.env.EXAMPLE_API_KEY ?? null };
if (proxy) {
  capture.controlModel = await connect("model.fake.test");
  capture.controlRegistry = await connect("registry.fake.test");
  capture.controlGithub = await connect("api.github.com");
  // pi's bash tool: its shell, the prefix and the command joined by a newline, pi's own environment.
  const bash = (command) => Bun.spawnSync([settings.shellPath, "-c", settings.shellCommandPrefix + "\\n" + command], { env: process.env });
  capture.echo = text(bash("echo ok").stdout).trim();
  const file = /^\\. '(.*)' \\|\\| exit 126$/.exec(settings.shellCommandPrefix)?.[1];
  capture.commandEnvironment = file ?? null;
  capture.rewriteExit = bash("echo 'export HTTPS_PROXY=x' >> " + file).exitCode;
  const command = bash('"' + process.execPath + '" -e "$PROBE"');
  capture.command = command.exitCode === 0 ? JSON.parse(text(command.stdout)) : text(command.stderr);
  // pi's MCP support: the configured command and arguments, no shell, pi's environment plus the server's env.
  const server = mcp.mcpServers.conveyor;
  const started = Bun.spawnSync([server.command, ...server.args], { env: { ...process.env, ...(server.env ?? {}) } });
  capture.mcpServer = started.exitCode === 0 ? JSON.parse(text(started.stdout)) : text(started.stderr);
}
let writable = true;
try { await Bun.write(process.cwd() + "/write-marker", "x"); } catch { writable = false; }
capture.workspaceWritable = writable;
await Bun.write(process.env.CAPTURE, JSON.stringify(capture));
console.log(JSON.stringify({ type: "session", version: 3, id: "egress-1", timestamp: "2026-11-13T10:00:00.000Z", cwd: process.cwd() }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(${JSON.stringify(VALID_RESULT)}) }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } }));
`;

async function listen(socketPathOrPort: string | number, reply?: string): Promise<net.Server> {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    if (reply) socket.end(reply);
  });
  await new Promise<void>((resolve) => (typeof socketPathOrPort === "string" ? server.listen(socketPathOrPort, resolve) : server.listen(socketPathOrPort, "127.0.0.1", resolve)));
  servers.push(server);
  return server;
}

async function run(options: { sandbox?: "read-only" | "workspace-write"; mcp?: boolean } = {}) {
  const directory = await shortTemporaryDirectory("conveyor-pe-", { socketPath: "artifacts/run-1/net/control.sock", visibleInSandbox: true });
  directories.push(directory);
  const { command } = await installFakePi(path.join(directory, "install"), FAKE_PI);
  const workspace = path.join(directory, "workspace");
  const service = path.join(directory, "service-pi");
  const artifacts = path.join(directory, "artifacts", "run-1");
  await Promise.all([mkdir(workspace), mkdir(service)]);
  const model = await listen(0);
  const hostService = await listen(0, "host-service");
  const mcpSocket = path.join(directory, "mcp.sock");
  if (options.mcp) await listen(mcpSocket, "mcp-ok");
  const capture = path.join(artifacts, "capture.json");
  const port = (server: net.Server) => (server.address() as net.AddressInfo).port;
  const envelope = await runPi({
    command,
    workspace,
    artifactsDirectory: artifacts,
    prompt: "go",
    sandbox: options.sandbox ?? "workspace-write",
    automaticApprovals: false,
    // The run-scoped MCP server stands in for Conveyor's: it reports what it was started with.
    mcp: { command: process.execPath, args: ["-e", PROBE] },
    runner: { type: "pi", command, credentialVariables: ["EXAMPLE_API_KEY"] } as never,
    env: {
      CAPTURE: capture, PROBE, PI_CODING_AGENT_DIR: service, EXAMPLE_API_KEY: "key-secret",
      HOST_PORT: String(port(hostService)), ...(options.mcp ? { MCP_PORT: "4310" } : {}),
    },
    egress: {
      httpsHosts: ["registry.fake.test"],
      controlPlaneHosts: ["model.fake.test"],
      ...(options.mcp ? { mcp: { port: 4310, socket: mcpSocket } } : {}),
      resolve: async (host: string) => (host === "other.fake.test" ? ["10.0.0.5"] : ["203.0.113.1"]),
      dial: () => net.connect(port(model), "127.0.0.1"),
    },
  });
  return { envelope, capture: JSON.parse(await readFile(capture, "utf8")), artifacts };
}

describeSandbox("runPi with agent egress", () => {
  test("pi gets the control-plane proxy for itself; its commands get the data-plane proxy without its agent directory or credentials", async () => {
    const { envelope, capture, artifacts } = await run();
    expect(envelope).toMatchObject({ sessionId: "egress-1", stageResult: { status: "done" } });
    // pi's own connection reaches only its control-plane hosts, and it keeps its credential.
    expect(capture.proxy).toMatch(/^http:\/\/conveyor:[A-Za-z0-9_%-]{20,}@127\.0\.0\.1:\d+$/);
    expect(capture.credential).toBe("key-secret");
    expect(capture.controlModel).toBe("200");
    expect(capture.controlRegistry).toBe("403");
    expect(capture.controlGithub).toBe("403");
    // Its commands source the run's command environment, which they cannot rewrite.
    expect(capture.commandEnvironment).toBe(path.join(artifacts, "net", "command-environment"));
    expect(capture.echo).toBe("ok");
    expect(capture.rewriteExit).not.toBe(0);
    expect(capture.command.proxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(capture.command.agentDir).toBeNull();
    expect(capture.command.credential).toBeNull();
    expect(capture.command.allowed).toBe("200");
    for (const refused of ["model", "unlisted", "github", "ipLiteral"]) expect(capture.command[refused]).toBe("403");
    expect(["ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED", "timeout"]).toContain(capture.command.directIp);
    // Per-run network state is removed after the run.
    expect(await readdir(path.join(artifacts, "net"))).toEqual([]);
  });

  test("an MCP server pi starts gets the same data-plane environment as its commands", async () => {
    const { capture } = await run();
    expect(capture.mcpServer.proxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(capture.mcpServer.agentDir).toBeNull();
    expect(capture.mcpServer.credential).toBeNull();
    expect(capture.mcpServer.allowed).toBe("200");
    expect(capture.mcpServer.model).toBe("403");
  });

  test("exposes the MCP loopback forward only when granted; host loopback services stay unreachable", async () => {
    const granted = await run({ mcp: true });
    expect(granted.capture.command.mcp).toBe("mcp-ok");
    expect(granted.capture.command.hostLoopback).toBe("ECONNREFUSED");
    const withheld = await run();
    expect(withheld.capture.command.mcp).toBeNull();
    expect(withheld.capture.command.hostLoopback).toBe("ECONNREFUSED");
  });

  test("keeps file confinement: a read-only agent cannot write its worktree, a workspace-write agent can", async () => {
    expect((await run({ sandbox: "read-only" })).capture.workspaceWritable).toBe(false);
    expect((await run({ sandbox: "workspace-write" })).capture.workspaceWritable).toBe(true);
  });
});

describe("runPi egress setup failure", () => {
  test("fails the run without launching pi when the egress sockets cannot be created", async () => {
    const directory = await shortTemporaryDirectory("conveyor-pe-");
    directories.push(directory);
    const marker = path.join(directory, "launched");
    const { command } = await installFakePi(path.join(directory, "install"), `await Bun.write(${JSON.stringify(marker)}, "x");`);
    const workspace = path.join(directory, "workspace");
    const service = path.join(directory, "service-pi");
    await Promise.all([mkdir(workspace), mkdir(service)]);
    await expect(runPi({
      command, workspace, artifactsDirectory: path.join(directory, "x".repeat(120), "run-1"), prompt: "go", sandbox: "read-only", automaticApprovals: false,
      mcp: { command: "bun", args: ["x"] }, runner: { type: "pi", command }, env: { PI_CODING_AGENT_DIR: service },
      egress: { httpsHosts: [], controlPlaneHosts: ["model.fake.test"] },
    })).rejects.toThrow(/egress socket|shorter/);
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});
