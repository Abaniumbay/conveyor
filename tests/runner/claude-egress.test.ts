import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { runClaudeCode } from "../../src/runner/claude-code";
import { CLAUDE_CONTROL_PLANE_HOSTS, claudeShellPrefix } from "../../src/isolation/run-network";
import { bwrapUnavailableReason } from "../support/bwrap";
import { shortTemporaryDirectory } from "../support/short-temporary-directory";

const unavailable = bwrapUnavailableReason();
if (unavailable) console.warn(`SKIPPED Claude egress tests: \`bwrap --unshare-net\` is unavailable (${unavailable})`);
const describeSandbox = unavailable ? describe.skip : describe;

const directories: string[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// What Claude's `Bash` tool command sees: the prefix runs first, then the command.
const COMMAND_PROBE = `
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
    proxy, configDir: process.env.CLAUDE_CONFIG_DIR ?? null, apiKey: process.env.ANTHROPIC_API_KEY ?? null,
    allowed: await connect(proxy, "registry.fake.test"),
    model: await connect(proxy, "model.fake.test"),
    unlisted: await connect(proxy, "other.fake.test"),
    github: await connect(proxy, "api.github.com"),
    uploads: await connect(proxy, "uploads.github.com"),
    ipLiteral: await connect(proxy, "203.0.113.9"),
    directIp: await direct("203.0.113.9"),
    mcp: process.env.MCP_PORT ? await loopback(Number(process.env.MCP_PORT)) : null,
    hostLoopback: await loopback(Number(process.env.HOST_PORT)),
  };
  console.log(JSON.stringify(result));
})();
`;

const FAKE_CLAUDE = `#!/usr/bin/env bun
import net from "node:net";
const args = process.argv.slice(2);
await new Response(Bun.stdin.stream()).text();
const proxy = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null;
const connect = (host) => new Promise((resolve) => {
  const socket = net.connect(Number(proxy.port), proxy.hostname);
  let raw = "";
  socket.on("error", (e) => resolve(e.code));
  socket.on("data", (c) => { raw += c; if (raw.includes("\\r\\n\\r\\n")) { socket.destroy(); resolve(raw.split(" ")[1]); } });
  const auth = Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64");
  socket.write("CONNECT " + host + ":443 HTTP/1.1\\r\\nHost: " + host + ":443\\r\\nProxy-Authorization: Basic " + auth + "\\r\\n\\r\\n");
});
const capture = { args, proxy: process.env.HTTPS_PROXY, prefix: process.env.CLAUDE_CODE_SHELL_PREFIX, cwd: process.cwd() };
if (proxy) {
  capture.controlModel = await connect("model.fake.test");
  capture.controlRegistry = await connect("registry.fake.test");
  capture.controlGithub = await connect("api.github.com");
  const command = Bun.spawnSync(["sh", "-c", process.env.CLAUDE_CODE_SHELL_PREFIX + ' "$0" -e "$1"', process.execPath, process.env.COMMAND_PROBE], { env: process.env });
  capture.command = command.exitCode === 0 ? JSON.parse(new TextDecoder().decode(command.stdout)) : new TextDecoder().decode(command.stderr);
}
let writable = true;
try { await Bun.write(process.cwd() + "/write-marker", "x"); } catch { writable = false; }
capture.workspaceWritable = writable;
await Bun.write(process.env.CAPTURE, JSON.stringify(capture));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "s", usage: { input_tokens: 1, output_tokens: 1 }, structured_output: { version: 1, outcome: "success", status: "done", summary: "ok", reason: null, metrics: {}, artifacts: [] } }));
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

async function run(options: { egress: boolean; sandbox?: "read-only" | "workspace-write"; mcp?: boolean; network?: boolean; resume?: boolean }) {
  const directory = await shortTemporaryDirectory("conveyor-cl-", { socketPath: "artifacts/run-1/net/control.sock", visibleInSandbox: true });
  directories.push(directory);
  const workspace = path.join(directory, "workspace");
  const artifacts = path.join(directory, "artifacts", "run-1");
  await mkdir(workspace);
  const executable = path.join(directory, "claude");
  await writeFile(executable, FAKE_CLAUDE);
  await chmod(executable, 0o755);
  const model = await listen(0);
  const hostService = await listen(0, "host-service");
  const mcpSocket = path.join(directory, "mcp.sock");
  if (options.mcp) await listen(mcpSocket, "mcp-ok");
  const capture = path.join(artifacts, "capture.json");
  const port = (server: net.Server) => (server.address() as net.AddressInfo).port;
  await runClaudeCode({
    command: executable,
    workspace,
    artifactsDirectory: artifacts,
    prompt: "go",
    sandbox: options.sandbox ?? "workspace-write",
    automaticApprovals: false,
    mcp: { command: "bun", args: ["x"] },
    ...(options.network ? { network: true } : {}),
    ...(options.resume ? { resumeSessionId: "sess-1" } : {}),
    env: { CAPTURE: capture, COMMAND_PROBE, HOST_PORT: String(port(hostService)), ...(options.mcp ? { MCP_PORT: "4310" } : {}) },
    ...(options.egress
      ? {
          egress: {
            httpsHosts: ["registry.fake.test"],
            controlPlaneHosts: ["model.fake.test"],
            ...(options.mcp ? { mcp: { port: 4310, socket: mcpSocket } } : {}),
            resolve: async (host: string) => (host === "other.fake.test" ? ["10.0.0.5"] : ["203.0.113.1"]),
            dial: () => net.connect(port(model), "127.0.0.1"),
          },
        }
      : {}),
  });
  return { capture: JSON.parse(await readFile(capture, "utf8")), artifacts };
}

describe("Claude Code control-plane defaults", () => {
  test("default to Anthropic's hosts only", () => {
    expect(CLAUDE_CONTROL_PLANE_HOSTS).toEqual(["api.anthropic.com", "console.anthropic.com", "platform.claude.com", "claude.ai"]);
  });

  test("the command prefix carries data-plane proxy variables and drops harness credentials, never a token", () => {
    const prefix = claudeShellPrefix({ HTTPS_PROXY: "http://127.0.0.1:3128", NO_PROXY: "" });
    expect(prefix).toBe("/usr/bin/env -u CLAUDE_CONFIG_DIR -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY HTTPS_PROXY=http://127.0.0.1:3128 NO_PROXY=");
  });
});

describeSandbox("runClaudeCode with agent egress", () => {
  test("starts in the network sandbox with the control-plane proxy for itself and the data-plane proxy for commands", async () => {
    const { capture, artifacts } = await run({ egress: true });
    expect(capture.proxy).toMatch(/^http:\/\/conveyor:[A-Za-z0-9_%-]{20,}@127\.0\.0\.1:\d+$/);
    // Claude Code's own connection reaches only its control-plane hosts.
    expect(capture.controlModel).toBe("200");
    expect(capture.controlRegistry).toBe("403");
    expect(capture.controlGithub).toBe("403");
    // Its commands run under the data-plane proxy, without the credential.
    expect(capture.prefix).not.toContain("conveyor:");
    expect(capture.command.proxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(capture.command.configDir).toBeNull();
    expect(capture.command.apiKey).toBeNull();
    expect(capture.command.allowed).toBe("200");
    for (const refused of ["model", "unlisted", "github", "uploads", "ipLiteral"]) expect(capture.command[refused]).toBe("403");
    expect(["ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED", "timeout"]).toContain(capture.command.directIp);
    // Per-run network state is removed after the run.
    expect(await readdir(path.join(artifacts, "net"))).toEqual([]);
  });

  test("a resumed run is isolated the same way", async () => {
    const { capture } = await run({ egress: true, resume: true });
    expect(capture.args).toContain("--resume");
    expect(capture.command.allowed).toBe("200");
    expect(capture.command.unlisted).toBe("403");
  });

  test("exposes the MCP loopback forward only when granted; host loopback services stay unreachable", async () => {
    const granted = await run({ egress: true, mcp: true });
    expect(granted.capture.command.mcp).toBe("mcp-ok");
    expect(granted.capture.command.hostLoopback).toBe("ECONNREFUSED");
    const withheld = await run({ egress: true });
    expect(withheld.capture.command.mcp).toBeNull();
    expect(withheld.capture.command.hostLoopback).toBe("ECONNREFUSED");
  });

  test("web tools stay off unless the agent has network, and the Bash allowlist is unchanged", async () => {
    const off = (await run({ egress: true })).capture.args as string[];
    const on = (await run({ egress: true, network: true })).capture.args as string[];
    const tools = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!.split(",");
    expect(tools(off, "--tools")).not.toContain("WebFetch");
    expect(tools(off, "--allowedTools")).not.toContain("WebSearch");
    expect(tools(on, "--tools")).toEqual(expect.arrayContaining(["WebFetch", "WebSearch", "Bash"]));
    const withoutWeb = (list: string[]) => list.filter((tool) => !["WebFetch", "WebSearch"].includes(tool));
    expect(withoutWeb(tools(on, "--allowedTools"))).toEqual(tools(off, "--allowedTools"));
    expect(withoutWeb(tools(on, "--tools"))).toEqual(tools(off, "--tools"));
  });

  test("keeps file confinement: a read-only agent cannot write its worktree, a workspace-write agent can", async () => {
    expect((await run({ egress: true, sandbox: "read-only" })).capture.workspaceWritable).toBe(false);
    expect((await run({ egress: true, sandbox: "workspace-write" })).capture.workspaceWritable).toBe(true);
  });

  test("without an egress policy it launches as before: no proxies and no command prefix", async () => {
    const { capture } = await run({ egress: false });
    expect(capture.proxy).toBeUndefined();
    expect(capture.prefix).toBeUndefined();
  });
});

describe("runClaudeCode egress setup failure", () => {
  test("fails the run without launching Claude Code when the egress sockets cannot be created", async () => {
    const directory = await shortTemporaryDirectory("conveyor-cl-");
    directories.push(directory);
    const workspace = path.join(directory, "workspace");
    const artifacts = path.join(directory, "x".repeat(120), "run-1");
    await mkdir(workspace);
    const marker = path.join(directory, "launched");
    const executable = path.join(directory, "claude");
    await writeFile(executable, `#!/bin/sh\ntouch ${marker}\n`);
    await chmod(executable, 0o755);
    await expect(runClaudeCode({
      command: executable, workspace, artifactsDirectory: artifacts, prompt: "go", sandbox: "read-only", automaticApprovals: false,
      mcp: { command: "bun", args: ["x"] }, egress: { httpsHosts: [] },
    })).rejects.toThrow(/egress socket|shorter/);
    expect(await Bun.file(marker).exists()).toBe(false);
  });
});
