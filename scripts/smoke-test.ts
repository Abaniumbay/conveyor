#!/usr/bin/env bun
// Package acceptance test: installs a release archive with install.sh and exercises the installed
// executable outside the checkout, with no Bun and no node_modules on PATH: init, configuration with
// packaged defaults, the dashboard and its embedded assets, sign-in, the sandbox bridge, and a real
// agent run whose harness drives the packaged MCP server to report progress back to the service.
//
//   bun run scripts/smoke-test.ts --dist dist [--next dist-next] [--work <dir>] [--target linux-x64]
//
// With --next (a second build with another version), it also upgrades to it and rolls back.
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

/** A Codex stand-in for a repository with `agentEgress`: it must run inside the confined network bridge. */
const fakeCodexEgress = (home: string, executable: string): string => `#!/usr/bin/env python3
import json, os, sys
sys.stdin.read()
def fail(message):
    print(json.dumps({"type": "error", "message": message}))
    sys.exit(1)
# The confined plan: the bridge is this process's parent and is the executable's own \`__bridge\` command...
parent = open("/proc/%d/cmdline" % os.getppid(), "rb").read().split(b"\\0")
if parent[:2] != [${JSON.stringify(executable)}.encode(), b"__bridge"]:
    fail("the parent is not the executable's __bridge: " + repr(parent[:3]))
# ...and the Conveyor home (state database, config) is not part of the agent's filesystem.
if os.path.exists(${JSON.stringify(home)} + "/state/conveyor.sqlite"):
    fail("the Conveyor home is visible: the turn is not in the confined filesystem plan")
output = sys.argv[sys.argv.index("-o") + 1]
proxy = os.environ.get("HTTPS_PROXY", "")
if "@127.0.0.1:" not in proxy and "//127.0.0.1:" not in proxy:
    print(json.dumps({"type": "error", "message": "not behind the egress bridge: " + proxy}))
    sys.exit(1)
json.dump({"version": 1, "outcome": "success", "status": "done", "summary": "egress smoke done", "reason": None, "metrics": {}, "artifacts": []}, open(output, "w"))
print(json.dumps({"type": "thread.started", "thread_id": "smoke-egress"}))
print(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "egress smoke done"}}))
print(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}}))
`;

/** A GitHub stand-in (`gh api ...`) serving one enrolled issue in smoke/app; every write is accepted and ignored. */
const FAKE_GH = `#!/usr/bin/env python3
import json, sys
args = sys.argv[1:]
if "--input" in args:
    sys.stdin.read()
if args[:1] == ["api"] and args[1:2] == ["graphql"]:
    print(json.dumps({"data": {"repository": {"issue": {"userContentEdits": {"nodes": [], "pageInfo": {"hasNextPage": False, "endCursor": None}}}}}}))
    sys.exit(0)
path = args[1] if len(args) > 1 and args[0] == "api" else ""
method = args[args.index("--method") + 1] if "--method" in args else "GET"
issue = {
    "id": 9001, "node_id": "I_smoke", "number": 1, "title": "Smoke item", "body": "Run the agent.", "state": "open",
    "labels": [{"name": "conveyor"}, {"name": "conveyor:smoke"}], "user": {"login": "owner", "type": "User"},
    "assignees": [], "comments": 0, "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
    "html_url": "https://github.com/owner/app/issues/1", "url": "https://api.github.com/repos/owner/app/issues/1",
    "repository_url": "https://api.github.com/repos/owner/app",
}
open(__file__ + ".log", "a").write(json.dumps(args) + "\\n")
if path.startswith("repos/owner/app/issues?"):
    print(json.dumps([issue]))
elif path == "repos/owner/app" and method == "GET":
    print(json.dumps({"private": True, "visibility": "private", "default_branch": "main", "full_name": "owner/app"}))
elif path.startswith("repos/owner/app/issues/1/events"):
    print(json.dumps([{"id": 1, "event": "labeled", "created_at": "2026-01-01T00:00:00Z", "label": {"name": "conveyor"}, "actor": {"login": "owner"}}]))
elif path.startswith("repos/owner/app/collaborators/"):
    print(json.dumps({"permission": "admin"}))
elif path == "repos/owner/app/issues/1" and method == "GET":
    print(json.dumps(issue))
elif "--paginate" in args:
    print("[]")
else:
    print("{}")
`;

/** Plays systemd's part (Restart=always): starts serve again when it exits to be restarted. */
class Supervisor {
  #child: ReturnType<typeof Bun.spawn> | null = null;
  #stopped = false;
  readonly exits: number[] = [];

  constructor(private readonly argv: string[], private readonly environment: Record<string, string>, private readonly logFile: string) {}

  start(): void {
    const output = Bun.file(this.logFile);
    const child = Bun.spawn(this.argv, { cwd: "/", env: { ...this.environment, INVOCATION_ID: "smoke-test" }, stdout: output, stderr: output });
    this.#child = child;
    void child.exited.then((code) => {
      this.exits.push(code);
      if (!this.#stopped && code === 75) this.start();
    });
  }

  async stop(): Promise<number> {
    this.#stopped = true;
    if (!this.#child) return 0;
    this.#child.kill("SIGTERM");
    return this.#child.exited;
  }
}

async function main(): Promise<void> {
  const dist = path.resolve(argument("dist"));
  const target = argument("target", "linux-x64");
  const archive = (await readdir(dist)).find((file) => file.endsWith(`-${target}.tar.gz`));
  if (!archive) throw new Error(`no ${target} archive in ${dist}`);
  const base = path.resolve(argument("work", process.env.RUNNER_TEMP ?? path.join(homedir(), ".cache")));
  await mkdir(base, { recursive: true });
  const work = await mkdtemp(path.join(base, "conveyor-smoke-"));
  if (work.startsWith("/tmp/")) throw new Error("the work directory must not be under /tmp (the sandbox hides it)");
  let server: Supervisor | null = null;
  const shortArtifacts = await mkdtemp("/dev/shm/conveyor-smoke-");
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

    // A repository on the packaged stages compiles from the embedded defaults.
    const repository = path.join(work, "repos/app");
    await mkdir(repository, { recursive: true });
    await exec(["git", "init", "-q", "-b", "main", repository]);
    await exec(["git", "-C", repository, "-c", "user.name=smoke", "-c", "user.email=smoke@example.com", "commit", "-q", "--allow-empty", "-m", "initial"]);
    await writeFile(path.join(home, "config/repositories/app.yaml"), [
      "items: github", "code: github", "ci: { mode: disabled }", "address: owner/app", `folder: ${repository}`,
      "agentEgress: { allowLoopbackMcp: true, httpsHosts: [registry.npmjs.org] }", "",
    ].join("\n"));
    const checked = await run("config", "check", "--home", home);
    check(checked.code === 0 && checked.stdout.includes("Repository app"), `config check compiles the packaged stages: ${checked.stderr.trim()}`);
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
    await writeFile(path.join(tools, "codex-egress"), fakeCodexEgress(home, conveyor));
    await chmod(path.join(tools, "codex-egress"), 0o755);
    await writeFile(path.join(tools, "gh"), FAKE_GH);
    await chmod(path.join(tools, "gh"), 0o755);
    const port = await freePort();
    await mkdir(path.join(work, "workspace"), { recursive: true });
    await writeFile(path.join(home, "config/smoke.md"), "You are a smoke test.\n");
    const entrypoint = path.join(home, "config/conveyor.yaml");
    await writeFile(entrypoint, [
      // Run sockets live under the artifacts directory, and a Unix socket path is limited to 100 bytes.
      `settings: { artifacts: ${shortArtifacts} }`,
      "web:",
      `  listen: 127.0.0.1:${port}`,
      `  steering: { agent: smoke, workspace: ${path.join(work, "workspace")} }`,
      "providers: !include builtin:providers.yaml",
      "repositories: !include_dir_named repositories/",
      "harnesses:",
      `  fake-codex: { type: codex, command: ${path.join(tools, "codex")}, sandbox: read-only }`,
      `  fake-egress: { type: codex, command: ${path.join(tools, "codex-egress")}, sandbox: read-only }`,
      "agents:",
      "  smoke: { name: Smoke, title: Tester, harness: fake-codex, instructions: ./smoke.md, access: read-only, tasks: [agent.reportProgress] }",
      "  egress: { name: Egress, title: Tester, harness: fake-egress, instructions: ./smoke.md, access: read-only, tasks: [] }",
      "stages:",
      "  - id: smoke",
      "    concurrency: 1",
      "    actions: [{ id: turn, task: agent.run, with: { agent: egress } }]",
      "    exit-gate: [{ id: labels, task: item.labelsValid }]",
      "",
    ].join("\n"));
    server = new Supervisor([path.join(work, "prefix/current/conveyor"), "serve", "--home", home], environment, path.join(work, "serve.log"));
    server.start();
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
    const shell = await (await fetch(`${url}/operator`, { headers: { cookie: cookie! } })).text();
    const appScript = /src="(\/assets\/app\.js\?v=[a-z0-9]+)"/.exec(shell)?.[1];
    const appBundle = appScript ? await fetch(`${url}${appScript}`) : null;
    check(Boolean(appBundle?.ok) && (await appBundle!.text()).length > 10_000 && shell.includes("data-app-skeleton"), "the embedded dashboard application is served");
    const snapshot = await (await fetch(`${url}/api/v1/snapshot`, { headers: { cookie: cookie! } })).json() as { csrfToken?: string; model?: { system?: unknown } };
    const csrf = snapshot.csrfToken;
    check(csrf && snapshot.model?.system, "the signed-in dashboard model loads");

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

    // A repository with agentEgress: the agent's turn runs in the confined filesystem plan behind the
    // network bridge, which a compiled build must start with its own `__bridge` command.
    const egressDatabase = new Database(path.join(home, "state/conveyor.sqlite"), { readonly: true });
    let egressRun = null as { id: string; status: string } | null;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      egressRun = egressDatabase.query("SELECT id, status FROM runs WHERE id != ? AND status != 'running' ORDER BY rowid DESC LIMIT 1").get(runId) as { id: string; status: string } | null;
      if (egressRun) break;
      await Bun.sleep(200);
    }
    const egressEvents = egressRun ? (egressDatabase.query("SELECT type, payload_json AS payload FROM run_events WHERE run_id = ? ORDER BY id").all(egressRun.id) as Array<{ type: string; payload: string }>) : [];
    egressDatabase.close();
    const egressText = egressEvents.map((event) => `${event.type}: ${event.payload}`).join("\n");
    if (egressRun?.status !== "succeeded") console.error(egressText);
    check(egressRun?.status === "succeeded", `an agent turn in a repository with agentEgress succeeds behind the confined bridge (status ${egressRun?.status ?? "none"})`);
    check(egressText.includes("egress smoke done"), "the egress agent's turn ran inside the bridge");
    // The turn only succeeds when the wrapper started `<executable> __bridge` (an unknown command, as `-e`
    // was, ends the turn before the agent runs, so the status is not `succeeded`) and the agent sees the
    // confined plan: its parent is that bridge and the Conveyor home is hidden.
    check(!egressText.includes("not in the confined filesystem plan") && !egressText.includes("is not the executable's __bridge"), "the egress agent saw the confined plan and the executable's own bridge");

    const statusReport = await run("status", "--home", home, "--json");
    const reported = JSON.parse(statusReport.stdout) as { running: boolean; service: { version: { commit: string } } };
    check(statusReport.code === 0 && reported.running && reported.service.version.commit === version.commit, "status reaches the running service over its control socket");
    const serviceLog = await run("logs", "--home", home, "--level", "info");
    check(serviceLog.code === 0 && serviceLog.stdout.includes("started"), "logs reads the service log file");

    const nextDist = Bun.argv.includes("--next") ? path.resolve(argument("next")) : null;
    if (nextDist) {
      // Upgrade to a second build and roll back, with this script restarting serve like systemd.
      const nextArchive = (await readdir(nextDist)).find((file) => file.endsWith(`-${target}.tar.gz`));
      if (!nextArchive) throw new Error(`no ${target} archive in ${nextDist}`);
      const nextVersion = /^conveyor-v(.+)-linux-/.exec(nextArchive)![1]!;
      const upgraded = await run("upgrade", "--home", home, "--archive", path.join(nextDist, nextArchive), "--checksums", path.join(nextDist, "checksums.txt"), "--wait-timeout", "2m");
      check(upgraded.code === 0 && upgraded.stdout.includes(`from ${version.version} to ${nextVersion}`), `upgrade drains, switches, restarts and verifies ${nextVersion}: ${upgraded.stdout.trim()} ${upgraded.stderr.trim()}`);
      const afterUpgrade = JSON.parse((await run("status", "--home", home, "--json")).stdout) as { service: { version: { version: string } } };
      check(afterUpgrade.service.version.version === nextVersion && server.exits.includes(75), "the restarted service runs the new release");
      const rolledBack = await run("rollback", "--home", home, "--wait-timeout", "2m");
      check(rolledBack.code === 0 && rolledBack.stdout.includes(`from ${nextVersion} to ${version.version}`), `rollback returns to ${version.version}: ${rolledBack.stdout.trim()} ${rolledBack.stderr.trim()}`);
      const afterRollback = JSON.parse((await run("status", "--home", home, "--json")).stdout) as { service: { version: { version: string } } };
      check(afterRollback.service.version.version === version.version, "the service runs the previous release again, with its data");
    }

    const code = await server.stop();
    check(code === 0, "serve stops cleanly on SIGTERM");
    server = null;
    console.log(`Smoke test passed for ${archive}.`);
  } finally {
    if (server) {
      await server.stop();
      console.error(await Bun.file(path.join(work, "serve.log")).text().catch(() => ""));
    }
    await rm(shortArtifacts, { recursive: true, force: true });
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
