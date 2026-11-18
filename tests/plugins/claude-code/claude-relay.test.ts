import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { defaultRunVariables } from "../../../src/isolation/run-environment";
import { runClaudeCode } from "../../../src/plugins/claude-code/claude-code";
import { claudeLaunch } from "../../../src/plugins/claude-code/launch";
import { bwrapUnavailableReason } from "../../support/bwrap";
import { startRelayUpstream, throwawayCertificate, type RelayUpstream } from "../../support/relay-upstream";
import { shortTemporaryDirectory } from "../../support/short-temporary-directory";

const unavailable = bwrapUnavailableReason();
if (unavailable) console.warn(`SKIPPED Claude relay tests: \`bwrap --unshare-net\` is unavailable (${unavailable})`);
const describeSandbox = unavailable ? describe.skip : describe;

const SECRETS = ["real-oauth-secret", "real-key-secret", "fixture-file-token", "fixture-oauth-token", "fixture-api-key"];

// The fake claude's secret patterns are built from parts, so neither its source, nor its command line, nor
// the environment variable that carries the scan program contains a secret literally.
const SCAN = `
const fs = require("node:fs");
const path = require("node:path");
const secrets = [["real","oauth","secret"], ["real","key","secret"], ["fixture","file","token"], ["fixture","oauth","token"], ["fixture","api","key"]].map((parts) => parts.join("-"));
const leaks = (text) => secrets.filter((secret) => text.includes(secret));
const out = { environLeaks: [], cmdlineLeaks: [], pids: 0, users: [], nets: [], bwrapProcesses: 0, files: [], leakedFiles: [], harnessEnvironReadable: false, harnessHasPlaceholder: false };
const harness = process.env.HARNESS_PID;
for (const pid of fs.readdirSync("/proc").filter((entry) => /^[0-9]+$/.test(entry))) {
  out.pids += 1;
  try { const text = fs.readFileSync("/proc/" + pid + "/environ", "latin1"); if (leaks(text).length) out.environLeaks.push(pid);
    if (pid === harness) { out.harnessEnvironReadable = true; out.harnessHasPlaceholder = text.includes(process.env.PLACEHOLDER); } } catch {}
  try { const text = fs.readFileSync("/proc/" + pid + "/cmdline", "latin1"); if (leaks(text).length) out.cmdlineLeaks.push(pid);
    if (path.basename(text.split("\\0")[0] ?? "") === "bwrap") out.bwrapProcesses += 1; } catch {}
  try { out.users.push(fs.readlinkSync("/proc/" + pid + "/ns/user")); } catch {}
  try { out.nets.push(fs.readlinkSync("/proc/" + pid + "/ns/net")); } catch {}
}
const walk = (entry) => {
  let children;
  try { children = fs.readdirSync(entry, { withFileTypes: true }); } catch { children = undefined; }
  if (children) { for (const child of children) walk(path.join(entry, child.name)); return; }
  try { const text = fs.readFileSync(entry, "latin1"); out.files.push(entry); if (leaks(text).length) out.leakedFiles.push(entry); } catch {}
};
for (const root of JSON.parse(process.env.SCAN_ROOTS)) walk(root);
console.log(JSON.stringify(out));
`;

const PRELUDE = `#!/usr/bin/env bun
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
const args = process.argv.slice(2);
await new Response(Bun.stdin.stream()).text();
const text = (bytes) => new TextDecoder().decode(bytes);
const capture = { env: { ...process.env }, pid: process.pid };
const artifacts = path.dirname(process.env.CAPTURE);
const viaPrefix = (command) => Bun.spawnSync([process.env.CLAUDE_CODE_SHELL_PREFIX, command], { env: process.env });
const relay = (route, { method = "POST", headers = {}, body = "" } = {}) => new Promise((resolve) => {
  const url = new URL(process.env.ANTHROPIC_BASE_URL + route);
  const request = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, method, agent: false, headers: { ...headers, "content-length": Buffer.byteLength(body) } }, (response) => {
    let data = "";
    response.on("data", (chunk) => { data += chunk; });
    response.on("end", () => resolve({ status: response.statusCode, body: data }));
  });
  request.on("error", (error) => resolve({ error: error.code }));
  request.end(body);
});
const authorized = (extra = {}) => ({ authorization: "Bearer " + process.env.CLAUDE_CODE_OAUTH_TOKEN, "anthropic-version": "2023-06-01", ...extra });
const scan = () => {
  const roots = JSON.stringify([process.env.CLAUDE_CONFIG_DIR, process.env.HOME, artifacts, process.cwd(), process.env.TMPDIR]);
  const result = Bun.spawnSync([process.env.CLAUDE_CODE_SHELL_PREFIX, "HARNESS_PID=" + process.pid + " PLACEHOLDER=" + process.env.CONVEYOR_RELAY_PLACEHOLDER + " SCAN_ROOTS='" + roots + "' '" + process.execPath + "' -e \\"$SCAN\\""], { env: process.env });
  return JSON.parse(text(result.stdout));
};
const direct = () => new Promise((resolve) => {
  const socket = net.connect({ host: "203.0.113.9", port: 443, timeout: 1500 });
  socket.on("connect", () => { socket.destroy(); resolve("connected"); });
  socket.on("timeout", () => { socket.destroy(); resolve("timeout"); });
  socket.on("error", (error) => resolve(error.code));
});
`;
const FINISH = `
await Bun.write(process.env.CAPTURE, JSON.stringify(capture));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "s", usage: { input_tokens: 1, output_tokens: 1 }, structured_output: { version: 1, outcome: "success", status: "done", summary: "ok", reason: null, metrics: {}, artifacts: [] } }));
`;

const LOGIN = (token: string) => JSON.stringify({ claudeAiOauth: { accessToken: token } });

const directories: string[] = [];
const servers: net.Server[] = [];
const upstreams: RelayUpstream[] = [];
let certificate: Awaited<ReturnType<typeof throwawayCertificate>>;
beforeAll(async () => {
  if (!unavailable) certificate = await throwawayCertificate();
});
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface Scenario {
  /** The fake claude's behaviour, run after the prelude. */
  body: string;
  env?: Record<string, string>;
  /** Files of the service user's config directory (`.credentials.json` ...), relative to it. */
  config?: Record<string, string> | null;
  egress?: boolean;
  resume?: boolean;
  onEvent?: (event: unknown) => void;
  /** Runs while the fake claude is still running, with the run's directories. */
  during?: (paths: { directory: string; artifacts: string; config: string }) => Promise<void>;
}

async function listen(): Promise<net.Server> {
  const server = net.createServer((socket) => socket.on("error", () => {}));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return server;
}

async function run(scenario: Scenario) {
  const directory = await shortTemporaryDirectory("conveyor-rl-", { socketPath: "artifacts/run-1/net/control.sock", visibleInSandbox: true });
  directories.push(directory);
  const workspace = path.join(directory, "workspace");
  const artifacts = path.join(directory, "artifacts", "run-1");
  const config = path.join(directory, "svc-claude");
  await mkdir(workspace);
  await mkdir(config);
  for (const [name, content] of Object.entries(scenario.config ?? {})) {
    await mkdir(path.dirname(path.join(config, name)), { recursive: true });
    await writeFile(path.join(config, name), content);
  }
  const executable = path.join(directory, "claude");
  await writeFile(executable, PRELUDE + scenario.body + FINISH);
  await chmod(executable, 0o755);
  const upstream = await startRelayUpstream(certificate);
  upstreams.push(upstream);
  const model = await listen();
  const capturePath = path.join(artifacts, "capture.json");
  const events: unknown[] = [];
  const running = runClaudeCode({
    command: executable,
    workspace,
    artifactsDirectory: artifacts,
    prompt: "go",
    sandbox: "workspace-write",
    automaticApprovals: false,
    mcp: { command: "bun", args: ["x"] },
    ...(scenario.resume ? { resumeSessionId: "sess-1" } : {}),
    env: { ...defaultRunVariables(), CAPTURE: capturePath, SCAN, CLAUDE_CONFIG_DIR: config, ...scenario.env },
    programVariables: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    onEvent: (event) => { events.push(event); scenario.onEvent?.(event); },
    egress: {
      httpsHosts: scenario.egress ? ["registry.fake.test"] : [],
      ...(scenario.egress ? { controlPlaneHosts: ["model.fake.test"] } : {}),
      resolve: async () => ["203.0.113.1"],
      dial: () => net.connect((model.address() as net.AddressInfo).port, "127.0.0.1"),
      // The test seam: the real upstream is a local TLS server; the credential below is never used.
      relay: { upstream: `https://localhost:${upstream.port}`, ca: certificate.cert, credential: () => "unused" },
    },
  });
  const during = scenario.during?.({ directory, artifacts, config });
  const [envelope] = await Promise.all([running, during]);
  return { directory, artifacts, config, upstream, envelope, events, capture: JSON.parse(await readFile(capturePath, "utf8")) };
}

async function everyFile(directory: string): Promise<Array<{ file: string; content: string }>> {
  const found: Array<{ file: string; content: string }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await everyFile(file)));
    else if (entry.isFile()) found.push({ file, content: await readFile(file, "latin1") });
  }
  return found;
}

const hasSecret = (value: string): string[] => SECRETS.filter((secret) => value.includes(secret));
const TOKEN_FILE = { ".credentials.json": LOGIN("fixture-file-token") };
const REQUEST = `capture.reply = await relay("/v1/messages?beta=true", { headers: authorized(), body: '{"m":1}' });`;

// The command goes through CLAUDE_CODE_SHELL_PREFIX exactly as Claude's Bash tool would.
const READ_CREDENTIAL_FILE = `
const file = process.env.CLAUDE_CONFIG_DIR + "/.credentials.json";
capture.configDir = process.env.CLAUDE_CONFIG_DIR;
capture.cat = text(viaPrefix("cat " + file + " 2>&1; echo exit=$?").stdout);
try { capture.fsRead = fs.readFileSync(file, "utf8"); } catch (error) { capture.fsError = error.code; }
`;

describeSandbox("claudeLaunch", () => {
  test("AC-6.1: uses one bubblewrap with one network namespace and no user-namespace flags or nested sandbox", async () => {
    const directory = await shortTemporaryDirectory("conveyor-rl-", { socketPath: "artifacts/net/control.sock" });
    directories.push(directory);
    const dirs = Object.fromEntries(["workspace", "artifacts", "home", "scratch"].map((name) => [name, path.join(directory, name)]));
    for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
    const executable = path.join(directory, "claude");
    await writeFile(executable, "#!/bin/sh\n");
    await chmod(executable, 0o755);
    const policies = [
      { httpsHosts: ["registry.fake.test"], controlPlaneHosts: ["model.fake.test"] },
      { httpsHosts: [] },
    ];
    for (const policy of policies) {
      const launch = await claudeLaunch({
        command: executable,
        environment: { PATH: process.env.PATH ?? "" },
        artifactsDirectory: dirs.artifacts!,
        egress: { ...policy, relay: { upstream: "https://localhost:1", credential: () => "unused" } },
        filesystem: { command: executable, env: { PATH: process.env.PATH ?? "" }, workspace: dirs.workspace!, artifacts: dirs.artifacts!, home: dirs.home!, scratch: dirs.scratch! },
        buildArguments: () => ["-p"],
      });
      try {
        const argv = launch.argv;
        expect(argv.filter((argument) => path.basename(argument) === "bwrap")).toHaveLength(1);
        expect(argv.filter((argument) => argument === "--unshare-net")).toHaveLength(1);
        for (const flag of ["--unshare-user", "--unshare-user-try", "--unshare-all", "--userns", "--unshare-ipc"]) expect(argv).not.toContain(flag);
        expect(argv.some((argument) => /dangerously|--sandbox/.test(argument))).toBe(false);
        expect(launch.env.ANTHROPIC_BASE_URL).toBe(launch.network.relay!.url);
        expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(launch.network.relay!.placeholder);
      } finally {
        await launch.network.close();
      }
    }
  });
});

describeSandbox("Claude Code credentials in a real bubblewrap run", () => {
  describe("the service user's login file", () => {
    test("AC-1.1: a command cannot read the credential file of the runner's configDir", async () => {
      const { capture, config } = await run({ config: TOKEN_FILE, body: READ_CREDENTIAL_FILE });
      expect(capture.cat).not.toContain("fixture-file-token");
      expect(capture.fsRead === "" || typeof capture.fsError === "string").toBe(true);
      expect(JSON.stringify(capture)).not.toContain("fixture-file-token");
      expect(await readFile(path.join(config, ".credentials.json"), "utf8")).toBe(LOGIN("fixture-file-token"));
    });

    test("AC-1.2: with no configDir the service user's ~/.claude login file is unreadable too", async () => {
      const home = process.env.HOME;
      const configDir = process.env.CLAUDE_CONFIG_DIR;
      const directory = await shortTemporaryDirectory("conveyor-rl-", { socketPath: "artifacts/run-1/net/control.sock", visibleInSandbox: true });
      directories.push(directory);
      const serviceHome = path.join(directory, "home");
      await mkdir(path.join(serviceHome, ".claude"), { recursive: true });
      await writeFile(path.join(serviceHome, ".claude", ".credentials.json"), LOGIN("fixture-file-token"));
      process.env.HOME = serviceHome;
      delete process.env.CLAUDE_CONFIG_DIR;
      try {
        const upstream = await startRelayUpstream(certificate);
        upstreams.push(upstream);
        const workspace = path.join(directory, "workspace");
        const artifacts = path.join(directory, "artifacts", "run-1");
        await mkdir(workspace);
        const executable = path.join(directory, "claude");
        const serviceFile = path.join(serviceHome, ".claude", ".credentials.json");
        await writeFile(executable, `${PRELUDE}
capture.service = text(viaPrefix("cat ${serviceFile} 2>&1; echo exit=$?").stdout);
${READ_CREDENTIAL_FILE}
${FINISH}`);
        await chmod(executable, 0o755);
        await runClaudeCode({
          command: executable, workspace, artifactsDirectory: artifacts, prompt: "go", sandbox: "workspace-write", automaticApprovals: false,
          mcp: { command: "bun", args: ["x"] }, env: { ...defaultRunVariables(), CAPTURE: path.join(artifacts, "capture.json") },
          egress: { httpsHosts: [], relay: { upstream: `https://localhost:${upstream.port}`, ca: certificate.cert, credential: () => "unused" } },
        });
        const capture = JSON.parse(await readFile(path.join(artifacts, "capture.json"), "utf8"));
        expect(capture.service).not.toContain("fixture-file-token");
        expect(capture.cat).not.toContain("fixture-file-token");
        expect(capture.fsRead === "" || typeof capture.fsError === "string").toBe(true);
        expect(capture.configDir).toBe(path.join(serviceHome, ".claude"));
      } finally {
        if (home === undefined) delete process.env.HOME;
        else process.env.HOME = home;
        if (configDir !== undefined) process.env.CLAUDE_CONFIG_DIR = configDir;
      }
    });

    test("AC-1.3: session data in the config directory stays readable and writable, so --resume works", async () => {
      const { capture, config } = await run({
        resume: true,
        config: { ...TOKEN_FILE, "projects/p/sess-1.jsonl": "session-data" },
        body: `${READ_CREDENTIAL_FILE}
capture.session = fs.readFileSync(process.env.CLAUDE_CONFIG_DIR + "/projects/p/sess-1.jsonl", "utf8");
fs.writeFileSync(process.env.CLAUDE_CONFIG_DIR + "/projects/p/sess-2.jsonl", "new-session\\n");
capture.args = args;`,
      });
      expect(capture.session).toBe("session-data");
      expect(capture.args).toContain("--resume");
      expect(await readFile(path.join(config, "projects", "p", "sess-2.jsonl"), "utf8")).toBe("new-session\n");
      expect(capture.cat).not.toContain("fixture-file-token");
      expect(capture.fsRead === "" || typeof capture.fsError === "string").toBe(true);
    });
  });

  describe("secrets in the sandbox", () => {
    const secretEnv = { CLAUDE_CODE_OAUTH_TOKEN: "real-oauth-secret", ANTHROPIC_API_KEY: "real-key-secret" };

    test("AC-2.1: no environment, environ or command line the harness or a command can see holds a real secret", async () => {
      const { capture } = await run({ env: secretEnv, config: TOKEN_FILE, body: `capture.scan = scan(); capture.selfEnviron = fs.readFileSync("/proc/self/environ", "latin1");` });
      expect(capture.scan.pids).toBeGreaterThan(1);
      expect(capture.scan.environLeaks).toEqual([]);
      expect(capture.scan.cmdlineLeaks).toEqual([]);
      expect(hasSecret(capture.selfEnviron)).toEqual([]);
      expect(hasSecret(JSON.stringify(capture.env))).toEqual([]);
      // The harness's environ is readable and holds the placeholder: the case proves content, not a blocked file.
      expect(capture.scan.harnessEnvironReadable).toBe(true);
      expect(capture.scan.harnessHasPlaceholder).toBe(true);
      expect(capture.selfEnviron).toContain(capture.env.CONVEYOR_RELAY_PLACEHOLDER);
    });

    test("AC-2.2: no file a command can read inside the sandbox holds a real secret", async () => {
      const { capture, artifacts, directory } = await run({ env: secretEnv, config: { ...TOKEN_FILE, "projects/p/sess-1.jsonl": "data" }, body: `capture.scan = scan();` });
      expect(capture.scan.leakedFiles).toEqual([]);
      const visited: string[] = capture.scan.files;
      expect(visited.length).toBeGreaterThan(3);
      expect(visited).toContain(path.join(directory, "svc-claude", "projects", "p", "sess-1.jsonl"));
      expect(visited).not.toContain(path.join(directory, "svc-claude", ".credentials.json"));
      expect(visited).toContain(path.join(artifacts, "net", "shell-prefix"));
      expect(visited.some((file) => file.startsWith(path.join(artifacts, "home") + "/"))).toBe(true);
    });

    test("AC-2.3: the artifacts directory, the stderr and the stream events never hold a real secret", async () => {
      const { events, envelope, artifacts, capture } = await run({
        env: secretEnv,
        config: TOKEN_FILE,
        body: `console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: process.env.CLAUDE_CODE_OAUTH_TOKEN }] } }));`,
      });
      for (const { file, content } of await everyFile(artifacts)) expect([file, hasSecret(content)]).toEqual([file, []]);
      expect(hasSecret(envelope.stderr)).toEqual([]);
      expect(hasSecret(JSON.stringify(events))).toEqual([]);
      const echoed = (events as Array<{ message?: { content?: Array<{ text?: string }> } }>).find((event) => event.message)?.message?.content?.[0]?.text;
      expect(echoed).toBe(capture.env.CONVEYOR_RELAY_PLACEHOLDER);
    });
  });

  describe("launch environment", () => {
    const secretEnv = { CLAUDE_CODE_OAUTH_TOKEN: "real-oauth-secret", ANTHROPIC_API_KEY: "real-key-secret" };

    test("AC-3.1: ANTHROPIC_BASE_URL is the relay endpoint and CLAUDE_CODE_OAUTH_TOKEN the per-run placeholder", async () => {
      const { capture } = await run({ env: secretEnv, body: "" });
      expect(capture.env.ANTHROPIC_BASE_URL).toBe(capture.env.CONVEYOR_RELAY_URL);
      expect(capture.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(capture.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(capture.env.CONVEYOR_RELAY_PLACEHOLDER);
      expect(capture.env.CLAUDE_CODE_OAUTH_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(capture.env.CLAUDE_CODE_OAUTH_TOKEN).not.toBe("real-oauth-secret");
      expect(capture.env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    test("AC-3.2: the placeholder is per run, and the environment is the same with and without an agentEgress policy", async () => {
      const probe = `capture.direct = await direct();`;
      const a = (await run({ env: secretEnv, body: probe })).capture;
      const b = (await run({ env: secretEnv, body: probe, egress: true })).capture;
      const c = (await run({ env: secretEnv, body: probe })).capture;
      for (const capture of [a, b, c]) {
        expect(capture.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(capture.env.CLAUDE_CODE_OAUTH_TOKEN).toBeTruthy();
        expect(capture.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(capture.env.CONVEYOR_RELAY_PLACEHOLDER);
      }
      expect(new Set([a, b, c].map((capture) => capture.env.CLAUDE_CODE_OAUTH_TOKEN)).size).toBe(3);
      expect(["ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED", "timeout"]).toContain(a.direct);
    });

    test("AC-3.3: commands do not get the harness's credential variables or config directory", async () => {
      const { capture } = await run({
        env: secretEnv,
        body: `capture.command = text(viaPrefix('printf "%s|%s|%s" "$(printenv CLAUDE_CODE_OAUTH_TOKEN || echo unset)" "$(printenv ANTHROPIC_API_KEY || echo unset)" "$(printenv CLAUDE_CONFIG_DIR || echo unset)"').stdout);`,
      });
      expect(capture.command).toBe("unset|unset|unset");
    });
  });

  describe("authentication through the relay", () => {
    test("AC-4.1: a request carries the real token upstream while the harness holds only the placeholder", async () => {
      const { capture, upstream } = await run({ env: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth-token" }, body: REQUEST });
      expect(upstream.requests).toHaveLength(1);
      const request = upstream.requests[0]!;
      expect(request.url).toBe("/v1/messages?beta=true");
      expect(request.headers.authorization).toBe("Bearer fixture-oauth-token");
      expect(request.headers["anthropic-version"]).toBe("2023-06-01");
      expect(request.body).toBe('{"m":1}');
      expect(JSON.stringify(request)).not.toContain(capture.env.CONVEYOR_RELAY_PLACEHOLDER);
      expect(capture.env.CLAUDE_CODE_OAUTH_TOKEN).not.toBe("fixture-oauth-token");
      expect(capture.reply).toEqual({ status: 200, body: "upstream-ok" });
    });

    test("AC-4.2: the config directory the harness sees holds no credential, and the host's gains none", async () => {
      const { capture, upstream, config, artifacts } = await run({
        config: { ...TOKEN_FILE, "projects/p/sess-1.jsonl": "data" },
        body: `${REQUEST}
const listing = [];
const walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) walk(file); else { let content = ""; try { content = fs.readFileSync(file, "utf8"); } catch {} listing.push({ file, content }); } } };
walk(process.env.CLAUDE_CONFIG_DIR);
capture.listing = listing;`,
      });
      expect(capture.listing.map((entry: { file: string }) => path.relative(config, entry.file)).sort()).toContain("projects/p/sess-1.jsonl");
      for (const entry of capture.listing as Array<{ file: string; content: string }>) {
        expect(entry.content).not.toContain("fixture-file-token");
        if (path.basename(entry.file) === ".credentials.json") expect(entry.content).toBe("");
      }
      expect(upstream.requests.map((request) => request.headers.authorization)).toEqual(["Bearer fixture-file-token"]);
      expect((await readdir(config)).sort()).toEqual([".credentials.json", "projects"]);
      for (const { file, content } of await everyFile(artifacts)) {
        expect(path.basename(file)).not.toBe(".credentials.json");
        expect([file, hasSecret(content)]).toEqual([file, []]);
      }
    });

    test("AC-4.3: a token refreshed in the login file is used by the next request in the same run", async () => {
      const { upstream } = await run({
        config: { ".credentials.json": LOGIN("fixture-file-token-1") },
        body: `${REQUEST}
fs.writeFileSync(artifacts + "/ready", "1");
for (let waited = 0; !fs.existsSync(artifacts + "/go") && waited < 200; waited += 1) await Bun.sleep(50);
capture.second = await relay("/v1/messages", { headers: authorized(), body: "{}" });`,
        during: async ({ artifacts, config }) => {
          for (let waited = 0; !(await stat(path.join(artifacts, "ready")).catch(() => null)) && waited < 300; waited += 1) await Bun.sleep(50);
          await writeFile(path.join(config, ".credentials.json"), LOGIN("fixture-file-token-2"));
          await writeFile(path.join(artifacts, "go"), "1");
        },
      });
      expect(upstream.requests.map((request) => request.headers.authorization)).toEqual(["Bearer fixture-file-token-1", "Bearer fixture-file-token-2"]);
    });

    test("AC-4.4: with no credential anywhere nothing reaches the upstream and the harness learns no secret", async () => {
      const { capture, upstream } = await run({ body: REQUEST });
      expect(upstream.requests).toEqual([]);
      expect(capture.reply.status).toBe(502);
      expect(capture.reply.body).toBe("credential unavailable");
      expect(capture.reply.body).not.toContain(capture.env.CONVEYOR_RELAY_PLACEHOLDER);
      expect(capture.reply.body).not.toContain("/");
    });

    test("AC-4.5: a request without the run's placeholder is refused and never forwarded", async () => {
      const { capture, upstream } = await run({
        env: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth-token" },
        body: `capture.guessed = await relay("/v1/messages", { headers: { authorization: "Bearer fixture-oauth-token" }, body: "{}" });
capture.bare = await relay("/v1/messages", { body: "{}" });`,
      });
      expect(capture.guessed.status).toBe(401);
      expect(capture.bare.status).toBe(401);
      expect(upstream.requests).toEqual([]);
    });
  });

  describe("an API key instead of an OAuth token", () => {
    const keyEnv = { ANTHROPIC_API_KEY: "fixture-api-key" };

    test("AC-5.1: the relay sends the real key upstream as x-api-key", async () => {
      const { capture, upstream } = await run({ env: keyEnv, body: REQUEST });
      expect(upstream.requests).toHaveLength(1);
      const headers = upstream.requests[0]!.headers;
      expect(headers["x-api-key"]).toBe("fixture-api-key");
      expect(headers.authorization).toBeUndefined();
      expect(JSON.stringify(headers)).not.toContain(capture.env.CONVEYOR_RELAY_PLACEHOLDER);
      expect(capture.reply.status).toBe(200);
    });

    test("AC-5.2: the sandbox sees only a placeholder, never the key", async () => {
      const { capture } = await run({ env: keyEnv, body: "capture.scan = scan();" });
      expect(capture.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(capture.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(capture.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(capture.env.CONVEYOR_RELAY_PLACEHOLDER);
      expect(capture.scan.environLeaks).toEqual([]);
      expect(capture.scan.cmdlineLeaks).toEqual([]);
      expect(capture.scan.leakedFiles).toEqual([]);
      expect(capture.scan.files.some((file: string) => file.endsWith("/net/shell-prefix"))).toBe(true);
      expect(capture.scan.files.length).toBeGreaterThan(1);
      expect(hasSecret(JSON.stringify(capture.env))).toEqual([]);
    });

    test("AC-5.3: a client-supplied x-api-key never replaces the real key upstream", async () => {
      const { upstream } = await run({ env: keyEnv, body: `capture.reply = await relay("/v1/messages", { headers: authorized({ "x-api-key": "attacker-key" }), body: "{}" });` });
      expect(upstream.requests.map((request) => request.headers["x-api-key"])).toEqual(["fixture-api-key"]);
    });
  });

  describe("one namespace", () => {
    test("AC-6.2: every process shares one user and network namespace and no second bwrap runs", async () => {
      const { capture, upstream } = await run({ env: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth-token" }, body: `${REQUEST}\ncapture.scan = scan();` });
      expect(upstream.requests).toHaveLength(1);
      expect(capture.scan.users.length).toBeGreaterThan(0);
      expect(new Set(capture.scan.users).size).toBe(1);
      expect(capture.scan.nets.length).toBeGreaterThan(0);
      expect(new Set(capture.scan.nets).size).toBe(1);
      expect(capture.scan.bwrapProcesses).toBeLessThanOrEqual(1);
    });
  });
});
