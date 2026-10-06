#!/usr/bin/env bun
// Package acceptance test: installs a release archive with install.sh and exercises the installed
// executable outside the checkout, with no Bun and no node_modules on PATH: init, configuration with
// packaged defaults, the dashboard and its embedded assets, sign-in, the sandbox bridge, and a real
// agent run whose harness drives the packaged MCP server to report progress back to the service.
//
//   bun run scripts/smoke-test.ts --dist dist [--work <dir>] [--target linux-x64]
//
// The work directory must not be under /tmp: the sandbox mounts a private /tmp.

import { Database } from "bun:sqlite";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";

const PASSWORD = "smoke-test password";

function argument(name: string, fallback?: string): string {
  const index = Bun.argv.indexOf(`--${name}`);
  const value = index >= 0 ? Bun.argv[index + 1] : fallback;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`smoke test failed: ${message}`);
  console.log(`ok - ${message}`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** A Codex stand-in: starts the MCP server Conveyor configured, lists its tools, reports progress, prints Codex events. */
const FAKE_CODEX = `#!/usr/bin/env python3
import json, subprocess, sys
args = sys.argv[1:]
config = {}
for index, value in enumerate(args):
    if value == "-c":
        key, _, raw = args[index + 1].partition("=")
        config[key] = raw
command = json.loads(config["mcp_servers.conveyor.command"])
arguments = json.loads(config["mcp_servers.conveyor.args"])
sys.stdin.read()
server = subprocess.Popen([command] + arguments, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
def request(identifier, method, params):
    server.stdin.write(json.dumps({"jsonrpc": "2.0", "id": identifier, "method": method, "params": params}) + "\\n")
    server.stdin.flush()
    while True:
        message = json.loads(server.stdout.readline())
        if message.get("id") == identifier:
            return message
request(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "smoke", "version": "1"}})
server.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\\n")
server.stdin.flush()
tools = [tool["name"] for tool in request(2, "tools/list", {})["result"]["tools"]]
call = request(3, "tools/call", {"name": "agent.reportProgress", "arguments": {"message": "smoke progress through MCP"}})
server.stdin.close()
server.wait(timeout=10)
if call.get("error") or call["result"].get("isError"):
    print(json.dumps({"type": "error", "message": json.dumps(call)}))
    sys.exit(1)
print(json.dumps({"type": "thread.started", "thread_id": "smoke"}))
print(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "smoke done; tools: " + ",".join(tools)}}))
print(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}}))
`;

async function main(): Promise<void> {
  const dist = path.resolve(argument("dist"));
  const target = argument("target", "linux-x64");
  const archive = (await readdir(dist)).find((file) => file.endsWith(`-${target}.tar.gz`));
  if (!archive) throw new Error(`no ${target} archive in ${dist}`);
  const base = path.resolve(argument("work", process.env.RUNNER_TEMP ?? path.join(homedir(), ".cache")));
  await mkdir(base, { recursive: true });
  const work = await mkdtemp(path.join(base, "conveyor-smoke-"));
  if (work.startsWith("/tmp/")) throw new Error("the work directory must not be under /tmp (the sandbox hides it)");
  let server: ReturnType<typeof Bun.spawn> | null = null;
  try {
    const userHome = path.join(work, "user");
    const tools = path.join(work, "tools");
    await mkdir(userHome, { recursive: true });
    await mkdir(tools, { recursive: true });
    const PATH = [path.join(work, "bin"), tools, "/usr/local/bin", "/usr/bin", "/bin"].join(":");
    check(!Bun.which("bun", { PATH }), "bun is not on the PATH the installed executable sees");
    const environment = { HOME: userHome, PATH, LANG: "C.UTF-8" };

    const exec = async (argv: string[], options: { stdin?: string } = {}) => {
      const child = Bun.spawn(argv, { cwd: work, env: environment, stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin), stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, code };
    };

    // Install exactly as a user would, from the release files, with checksum verification.
    const installed = await exec(["sh", path.join(dist, "install.sh"), "--archive", path.join(dist, archive), "--checksums", path.join(dist, "checksums.txt"), "--prefix", path.join(work, "prefix"), "--bin-dir", path.join(work, "bin")]);
    check(installed.code === 0, `install.sh installs ${archive}: ${installed.stderr.trim()}`);
    const conveyor = path.join(work, "bin/conveyor");
    const run = (...argv: string[]) => exec([conveyor, ...argv]);

    const version = JSON.parse((await run("version", "--json")).stdout) as { version: string; commit: string; compiled: boolean };
    check(version.compiled && version.commit !== "development", `the executable reports its build (${version.version}, ${version.commit.slice(0, 12)})`);

    const home = path.join(work, "home");
    await writeFile(path.join(work, "password"), `${PASSWORD}\n`);
    const init = await run("init", "--home", home, "--admin-username", "admin", "--admin-password-file", path.join(work, "password"));
    check(init.code === 0, `init creates the home and the administrator: ${init.stderr.trim()}`);

    // A repository on the packaged delivery pipeline compiles from the embedded defaults.
    const repository = path.join(work, "repos/app");
    await mkdir(repository, { recursive: true });
    await exec(["git", "init", "-q", repository]);
    await writeFile(path.join(home, "config/repositories/app.yaml"), [
      "items: github", "code: github", "ci: { mode: disabled }", "address: owner/app", `folder: ${repository}`,
      "pipeline: delivery", "agentEgress: { allowLoopbackMcp: true, httpsHosts: [registry.npmjs.org] }", "",
    ].join("\n"));
    const checked = await run("config", "check", "--home", home);
    check(checked.code === 0 && checked.stdout.includes("Repository app"), `config check compiles the packaged pipeline: ${checked.stderr.trim()}`);
    const doctor = await run("doctor", "--home", home, "--json");
    const report = JSON.parse(doctor.stdout) as { checks: Array<{ name: string; status: string }> };
    check(report.checks.some((entry) => entry.name === "repository app" && entry.status === "ok"), "doctor runs and sees the repository checkout");

    // The bridge runs from the executable, directly and inside the sandbox namespace.
    const bridged = await run("__bridge", JSON.stringify({ forwards: [], command: ["sh", "-c", "exit 7"] }));
    check(bridged.code === 7, "the sandbox bridge mirrors the wrapped command's exit status");
    if (Bun.which("bwrap") && (await exec(["bwrap", "--unshare-net", "--dev-bind", "/", "/", "true"])).code === 0) {
      const sandboxed = await exec(["bwrap", "--unshare-net", "--unshare-pid", "--die-with-parent", "--dev-bind", "/", "/", "--proc", "/proc", "--tmpfs", "/tmp", "--", conveyor, "__bridge", JSON.stringify({ forwards: [], command: ["true"] })]);
      check(sandboxed.code === 0, `the bridge starts inside bwrap: ${sandboxed.stderr.trim()}`);
    } else {
      console.log("skip - bwrap cannot create namespaces here");
    }

    // A steering agent: its harness is a stand-in for Codex that drives the packaged MCP server.
    await writeFile(path.join(tools, "codex"), FAKE_CODEX);
    await chmod(path.join(tools, "codex"), 0o755);
    const port = await freePort();
    await mkdir(path.join(work, "workspace"), { recursive: true });
    await writeFile(path.join(home, "config/smoke.md"), "You are a smoke test.\n");
    const entrypoint = path.join(home, "config/conveyor.yaml");
    await writeFile(entrypoint, [
      "web:",
      `  listen: 127.0.0.1:${port}`,
      `  steering: { agent: smoke, workspace: ${path.join(work, "workspace")} }`,
      "providers: !include builtin:providers.yaml",
      "harnesses:",
      `  fake-codex: { type: codex, command: ${path.join(tools, "codex")}, sandbox: read-only }`,
      "agents:",
      "  smoke: { name: Smoke, title: Tester, harness: fake-codex, instructions: ./smoke.md, access: read-only, tasks: [agent.reportProgress] }",
      "",
    ].join("\n"));
    server = Bun.spawn([conveyor, "serve", "--home", home], { cwd: "/", env: environment, stdout: "pipe", stderr: "pipe" });
    const url = `http://127.0.0.1:${port}`;
    let live = false;
    for (let attempt = 0; attempt < 100 && !live; attempt += 1) {
      live = await fetch(`${url}/health/live`).then((response) => response.ok, () => false);
      if (!live) await Bun.sleep(200);
    }
    check(live, "serve starts and answers /health/live");

    const font = await fetch(`${url}/assets/fonts/ibm-plex-sans-400.woff2`);
    const bytes = new Uint8Array(await font.arrayBuffer());
    check(font.ok && new TextDecoder().decode(bytes.slice(0, 4)) === "wOF2", "the embedded dashboard fonts are served");

    const login = await fetch(`${url}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password: PASSWORD }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    check(login.status === 303 || login.status === 302 ? Boolean(cookie) : false, "the administrator from init signs in");
    const page = await (await fetch(`${url}/operator`, { headers: { cookie: cookie! } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1];
    check(csrf, "the signed-in dashboard renders");

    const started = await fetch(`${url}/steering`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: cookie!, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: csrf!, prompt: "Report progress." }),
    });
    const runId = decodeURIComponent(started.headers.get("location")?.split("/").pop() ?? "");
    check(runId, `a steering run starts (${started.status})`);

    const database = new Database(path.join(home, "state/conveyor.sqlite"), { readonly: true });
    let status = "running";
    for (let attempt = 0; attempt < 150 && status === "running"; attempt += 1) {
      await Bun.sleep(200);
      status = (database.query("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string } | null)?.status ?? "running";
    }
    const events = (database.query("SELECT type, payload_json AS payload FROM run_events WHERE run_id = ? ORDER BY id").all(runId) as Array<{ type: string; payload: string }>);
    database.close();
    const text = events.map((event) => `${event.type}: ${event.payload}`).join("\n");
    if (status !== "succeeded") console.error(text);
    check(status === "succeeded", `the agent run succeeds (status ${status})`);
    check(text.includes("smoke progress through MCP"), "the agent's MCP tool call reached the service through the packaged MCP server");
    check(text.includes("tools: agent.reportProgress"), "the packaged MCP server lists exactly the granted tools");

    server.kill("SIGTERM");
    const code = await server.exited;
    check(code === 0, "serve stops cleanly on SIGTERM");
    server = null;
    console.log(`Smoke test passed for ${archive}.`);
  } finally {
    if (server) {
      server.kill("SIGKILL");
      console.error(await new Response(server.stderr as ReadableStream).text());
    }
    if (!process.env.KEEP_SMOKE_WORK) await rm(work, { recursive: true, force: true });
    else console.log(`work directory kept: ${work}`);
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
