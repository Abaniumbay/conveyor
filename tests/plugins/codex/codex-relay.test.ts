import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { ConsoleSink, log, type LogRecord } from "../../../src/log/logger";
import { defaultRunVariables } from "../../../src/isolation/run-environment";
import { runCodex, type CodexRunInput } from "../../../src/plugins/codex/codex";
import { chatgptRecord, fixtureJwt, HOUR, secondsFromNow, writeLogin } from "../../support/codex-login";
import { bwrapUnavailableReason } from "../../support/bwrap";
import { startRelayUpstream, throwawayCertificate, type RelayUpstream, type TokenAnswer } from "../../support/relay-upstream";
import { shortTemporaryDirectory } from "../../support/short-temporary-directory";

const unavailable = bwrapUnavailableReason();
if (unavailable) console.warn(`SKIPPED codex relay tests: \`bwrap --unshare-net\` is unavailable (${unavailable})`);
const describeSandbox = unavailable ? describe.skip : describe;

const directories: string[] = [];
const upstreams: RelayUpstream[] = [];
const records: LogRecord[] = [];
afterEach(async () => {
  log.configure({ sinks: [new ConsoleSink()] });
  records.length = 0;
  await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// The fake `codex`: takes its base URL from the `-c` overrides and its credential from its own
// CODEX_HOME record or environment, as Codex does, then probes what the sandbox lets it read.
const FAKE_CODEX = `#!/usr/bin/env bun
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
const args = process.argv.slice(2);
await new Response(Bun.stdin.stream()).text();
const scenario = JSON.parse(process.env.SCENARIO);
const needles = scenario.needles.map((value) => Buffer.from(value, "base64"));
const hit = (buffer) => needles.some((needle) => buffer.includes(needle));
const out = { args, env: { CODEX_HOME: process.env.CODEX_HOME, OPENAI_API_KEY: process.env.OPENAI_API_KEY, CODEX_API_KEY: process.env.CODEX_API_KEY }, hits: [], procHits: [], responses: [] };
const read = (file) => { try { return fs.readFileSync(file); } catch (error) { return error; } };

const baseArg = args.find((arg) => arg.startsWith("openai_base_url="));
const base = baseArg ? new URL(JSON.parse(baseArg.slice("openai_base_url=".length))) : null;
const authText = read(process.env.CODEX_HOME + "/auth.json");
out.record = Buffer.isBuffer(authText) ? authText.toString("utf8") : null;
const parsed = out.record ? JSON.parse(out.record) : {};
const held = scenario.tokenFrom === "env" ? (process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY) : (parsed.tokens ? parsed.tokens.access_token : parsed.OPENAI_API_KEY);
out.held = held ?? null;

if (scenario.overwriteAuth) fs.writeFileSync(process.env.CODEX_HOME + "/auth.json", JSON.stringify({ tokens: "junk-from-sandbox" }));

const request = (step) => new Promise((resolve) => {
  const body = step.body ?? '{"input":"hi"}';
  const bearer = step.bearer === "held" || step.bearer === undefined ? held : step.bearer;
  const req = http.request({ host: "127.0.0.1", port: base.port, path: base.pathname.replace(/\\/$/, "") + step.path, method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: "Bearer " + bearer } : {}), ...(step.headers ?? {}) } }, (res) => {
    let text = ""; res.on("data", (c) => (text += c)); res.on("end", () => resolve({ status: res.statusCode, body: text }));
  });
  req.on("error", (e) => resolve({ error: e.code }));
  req.end(body);
});
if (base) for (const step of scenario.requests ?? []) out.responses.push(await request(step));

if (scenario.connect) {
  const proxy = new URL(process.env.HTTPS_PROXY);
  out.connect = await new Promise((resolve) => {
    const socket = net.connect(Number(proxy.port), proxy.hostname);
    let raw = "";
    socket.on("error", (e) => resolve(e.code));
    socket.on("data", (c) => { raw += c; if (raw.includes("\\r\\n\\r\\n")) { socket.destroy(); resolve(raw.split(" ")[1]); } });
    const auth = Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64");
    socket.write("CONNECT " + scenario.connect + " HTTP/1.1\\r\\nHost: " + scenario.connect + "\\r\\nProxy-Authorization: Basic " + auth + "\\r\\n\\r\\n");
  });
}

if (scenario.scan) {
  out.servicePath = (() => { const r = read(scenario.servicePath); return Buffer.isBuffer(r) ? "READ" : r.code; })();
  out.homeAuth = (() => { const r = read(process.env.HOME + "/.codex/auth.json"); return Buffer.isBuffer(r) ? r.toString("utf8") : r.code; })();
  out.envHit = hit(Buffer.from(JSON.stringify(process.env))) || hit(Buffer.from(JSON.stringify(args)));
  out.authFiles = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = dir === "/" ? "/" + entry.name : dir + "/" + entry.name;
      if (file === "/proc" || file === "/dev" || file === "/sys") continue;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        if (entry.name === "auth.json") out.authFiles.push(file);
        let size = 0; try { size = fs.statSync(file).size; } catch { continue; }
        if (size > 4_000_000) continue;
        const content = read(file);
        if (Buffer.isBuffer(content) && hit(content)) out.hits.push(file);
      }
    }
  };
  walk("/");
  const own = fs.readlinkSync("/proc/self/ns/user");
  out.userNs = { own, others: [] };
  for (const pid of fs.readdirSync("/proc").filter((name) => /^\\d+$/.test(name))) {
    for (const entry of ["environ", "cmdline"]) {
      const content = read("/proc/" + pid + "/" + entry);
      if (Buffer.isBuffer(content) && hit(content)) out.procHits.push(pid + "/" + entry);
    }
    try { out.userNs.others.push(fs.readlinkSync("/proc/" + pid + "/ns/user")); } catch {}
  }
}
await Bun.write(process.env.CAPTURE, JSON.stringify(out));
await Bun.write(args[args.indexOf("-o") + 1], JSON.stringify({ version: 1, outcome: "success", status: "done", summary: "ok", reason: null, metrics: {}, artifacts: [] }));
`;

interface Scenario {
  requests?: { path: string; bearer?: string; headers?: Record<string, string>; body?: string }[];
  needles?: string[];
  scan?: boolean;
  tokenFrom?: "env";
  overwriteAuth?: boolean;
  connect?: string;
}

async function fixture(options: { login?: unknown; token?: (body: string) => TokenAnswer }) {
  const directory = await shortTemporaryDirectory("conveyor-rl-", { socketPath: "artifacts/run-1/net/relay.sock", visibleInSandbox: true });
  directories.push(directory);
  const upstream = await startRelayUpstream(await throwawayCertificate(), options.token);
  upstreams.push(upstream);
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  const executable = path.join(directory, "codex");
  await writeFile(executable, FAKE_CODEX);
  await chmod(executable, 0o755);
  const serviceHome = path.join(directory, "service-codex");
  await mkdir(serviceHome, { recursive: true });
  if (options.login !== undefined) await writeLogin(serviceHome, options.login);
  return { directory, upstream, workspace, executable, serviceHome };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function run(f: Fixture, scenario: Scenario, extra: { env?: Record<string, string>; egress?: boolean; artifacts?: string } = {}) {
  const artifacts = extra.artifacts ?? path.join(f.directory, "artifacts", "run-1");
  const capture = path.join(artifacts, "capture.json");
  const base = `https://localhost:${f.upstream.port}`;
  const input: CodexRunInput = {
    command: f.executable,
    workspace: f.workspace,
    artifactsDirectory: artifacts,
    prompt: "go",
    sandbox: "workspace-write",
    automaticApprovals: false,
    mcp: { command: "bun", args: ["x"] },
    env: {
      ...defaultRunVariables(),
      CODEX_HOME: f.serviceHome,
      CAPTURE: capture,
      SCENARIO: JSON.stringify({ servicePath: path.join(f.serviceHome, "auth.json"), ...scenario, needles: (scenario.needles ?? []).map((value) => Buffer.from(value).toString("base64")) }),
      ...extra.env,
    },
    routing: { chatgptUpstream: `${base}/backend/codex`, apiUpstream: `${base}/v1`, tokenUrl: `${base}/oauth/token`, ca: f.upstream.cert },
    ...(extra.egress === false ? {} : { egress: { httpsHosts: [], controlPlaneHosts: [] } }),
  };
  log.configure({ sinks: [{ write: (record) => void records.push(record) }] });
  await runCodex(input);
  return { capture: JSON.parse(await readFile(capture, "utf8")), artifacts };
}

async function readTree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
}

async function expectNowhere(artifacts: string, needles: string[], capture: unknown): Promise<void> {
  for (const file of await readTree(artifacts)) {
    const content = await readFile(file, "utf8").catch(() => "");
    for (const needle of needles) expect(content.includes(needle)).toBe(false);
  }
  const everything = JSON.stringify([capture, records]);
  for (const needle of needles) expect(everything.includes(needle)).toBe(false);
}

function upstreamApiRequests(f: Fixture) {
  return f.upstream.requests.filter((request) => request.url !== "/oauth/token");
}

describeSandbox("runCodex through the credential relay", () => {
  test("a ChatGPT login is relayed: the run holds a placeholder and the upstream sees the real token (AC-1.1, 2.1, 3.1, 3.2, 1.3, 6.1)", async () => {
    const record = chatgptRecord("REAL-ACCESS-1");
    const tokens = record.tokens as Record<string, string>;
    const f = await fixture({ login: record });
    const before = await readFile(path.join(f.serviceHome, "auth.json"));
    const needles = [tokens.access_token!, tokens.refresh_token!, tokens.id_token!];

    const { capture, artifacts } = await run(f, {
      scan: true,
      needles,
      requests: [{ path: "/responses", headers: { "ChatGPT-Account-ID": "acct-fixture" } }],
    });

    expect(capture.responses).toEqual([{ status: 200, body: "upstream-ok" }]);
    const requests = upstreamApiRequests(f);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("/backend/codex/responses");
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${tokens.access_token}`);
    expect(requests[0]!.headers["chatgpt-account-id"]).toBe("acct-fixture");
    expect(requests[0]!.body).toBe('{"input":"hi"}');
    expect(JSON.stringify(requests[0]!.headers)).not.toContain(capture.held);

    // The harness holds a placeholder record whose id token has not expired, so Codex would not refresh.
    const held = JSON.parse(capture.record);
    expect(capture.held).not.toBe(tokens.access_token);
    expect(held.tokens.refresh_token).not.toBe(tokens.refresh_token);
    expect(JSON.parse(Buffer.from(held.tokens.id_token.split(".")[1], "base64url").toString()).exp).toBeGreaterThan(secondsFromNow(HOUR));
    expect(held.tokens.account_id).toBe("acct-fixture");

    expect(capture.servicePath).toBe("ENOENT");
    expect(capture.hits).toEqual([]);
    expect(capture.procHits).toEqual([]);
    expect(capture.envHit).toBe(false);
    expect(capture.authFiles).toContain(path.join(artifacts, "home", ".codex", "auth.json"));
    await expectNowhere(artifacts, needles, capture);

    // Routing is by Codex settings only, and the wrapper stays Codex's only sandbox (AC-3.2, AC-6.1).
    const args: string[] = capture.args;
    expect(args).toContain('openai_base_url="http://127.0.0.1:3140"');
    expect(args.filter((arg) => /base_url|chatgpt/i.test(arg))).toEqual(['openai_base_url="http://127.0.0.1:3140"']);
    expect(args).toContain("danger-full-access");
    expect(args.join(" ")).not.toMatch(/bwrap|landlock/i);
    const exclude = args.find((arg) => arg.startsWith("shell_environment_policy.exclude="))!;
    for (const name of ["CODEX_HOME", "CONVEYOR_RELAY_PLACEHOLDER", "CONVEYOR_RELAY_URL"]) expect(exclude).toContain(`"${name}"`);
    expect(capture.userNs.others.every((link: string) => link === capture.userNs.own)).toBe(true);

    // The host's login is untouched and the run's record is gone.
    expect(await readFile(path.join(f.serviceHome, "auth.json"))).toEqual(before);
    expect(await readTree(path.join(artifacts, "home"))).toEqual([]);
  });

  test("a record the sandbox overwrites is never promoted over the host's (AC-1.3)", async () => {
    const f = await fixture({ login: chatgptRecord("REAL-ACCESS-1") });
    const before = await readFile(path.join(f.serviceHome, "auth.json"));
    await run(f, { overwriteAuth: true });
    expect(await readFile(path.join(f.serviceHome, "auth.json"))).toEqual(before);
  });

  test("an API-key login is relayed with only a placeholder in the run (AC-1.2, 2.2, 5.1, 2.4)", async () => {
    const f = await fixture({ login: { auth_mode: "apikey", OPENAI_API_KEY: "sk-fixture-REAL-KEY-1" } });
    const needles = ["sk-fixture-REAL-KEY-1"];
    const { capture, artifacts } = await run(f, { scan: true, needles, requests: [{ path: "/responses" }, { path: "/error" }] });

    expect(capture.held).not.toBe("sk-fixture-REAL-KEY-1");
    expect(capture.held.length).toBeGreaterThan(20);
    expect(capture.responses).toEqual([{ status: 200, body: "upstream-ok" }, { status: 500, body: "upstream-failed" }]);
    const requests = upstreamApiRequests(f);
    expect(requests.map((request) => request.url)).toEqual(["/v1/responses", "/v1/error"]);
    for (const request of requests) {
      expect(request.headers.authorization).toBe("Bearer sk-fixture-REAL-KEY-1");
      expect(JSON.stringify(request.headers)).not.toContain(capture.held);
    }
    expect(capture.servicePath).toBe("ENOENT");
    expect(capture.hits).toEqual([]);
    expect(capture.procHits).toEqual([]);
    expect(capture.envHit).toBe(false);
    await expectNowhere(artifacts, needles, capture);
  });

  test("placeholders are per run and a foreign one, or the real key, is refused (AC-5.2)", async () => {
    const f = await fixture({ login: { auth_mode: "apikey", OPENAI_API_KEY: "sk-fixture-REAL-KEY-1" } });
    const first = await run(f, {}, { artifacts: path.join(f.directory, "artifacts", "run-1") });
    const second = await run(f, { requests: [{ path: "/responses", bearer: first.capture.held }, { path: "/responses", bearer: "sk-fixture-REAL-KEY-1" }] }, { artifacts: path.join(f.directory, "artifacts", "run-2") });

    expect(second.capture.held).not.toBe(first.capture.held);
    expect(second.capture.held).not.toBe("sk-fixture-REAL-KEY-1");
    expect(second.capture.responses.map((response: { status: number }) => response.status)).toEqual([401, 401]);
    expect(f.upstream.requests).toEqual([]);
  });

  test("a key from the harness environment is replaced by the placeholder (AC-2.3, 5.3)", async () => {
    for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY"]) {
      const f = await fixture({});
      const needles = ["sk-fixture-ENV-KEY-1"];
      const { capture, artifacts } = await run(f, { scan: true, needles, tokenFrom: "env", requests: [{ path: "/responses" }] }, { env: { [name]: "sk-fixture-ENV-KEY-1" } });

      expect(capture.env[name]).toBe(capture.held);
      expect(capture.held).not.toBe("sk-fixture-ENV-KEY-1");
      expect(capture.responses).toEqual([{ status: 200, body: "upstream-ok" }]);
      expect(upstreamApiRequests(f).map((request) => request.headers.authorization)).toEqual(["Bearer sk-fixture-ENV-KEY-1"]);
      expect(capture.hits).toEqual([]);
      expect(capture.procHits).toEqual([]);
      expect(capture.envHit).toBe(false);
      await expectNowhere(artifacts, needles, capture);
      const exclude = (capture.args as string[]).find((arg) => arg.startsWith("shell_environment_policy.exclude="))!;
      expect(exclude).toContain(`"${name}"`);
    }
  });

  test("an expired ChatGPT token is refreshed on the host and the run never sees the refresh token (AC-4.2, 4.5)", async () => {
    const expired = chatgptRecord("ACCESS-OLD", { expiresIn: -HOUR });
    const fresh = fixtureJwt({ exp: secondsFromNow(HOUR), marker: "ACCESS-NEW" });
    const f = await fixture({
      login: expired,
      token: () => ({ status: 200, body: JSON.stringify({ access_token: fresh, refresh_token: "REAL-REFRESH-2", id_token: fixtureJwt({ exp: secondsFromNow(HOUR), marker: "REAL-ID-2" }) }) }),
    });
    const old = expired.tokens as Record<string, string>;
    const needles = [old.access_token!, "REAL-REFRESH-1", "REAL-REFRESH-2", fresh];
    const { capture, artifacts } = await run(f, {
      scan: true,
      needles,
      connect: `localhost:${f.upstream.port}`,
      requests: [
        { path: "/responses" },
        { path: "/oauth/token", body: JSON.stringify({ refresh_token: "will-be-replaced" }) },
      ],
    });

    expect(capture.responses[0]).toEqual({ status: 200, body: "upstream-ok" });
    const posts = f.upstream.requests.filter((request) => request.url === "/oauth/token");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!.body).refresh_token).toBe("REAL-REFRESH-1");
    expect(upstreamApiRequests(f)[0]!.headers.authorization).toBe(`Bearer ${fresh}`);
    // The crafted token-endpoint path is only an ordinary forwarded API path under the API base.
    expect(upstreamApiRequests(f)[1]!.url).toBe("/backend/codex/oauth/token");
    expect(capture.connect).not.toBe("200");
    expect(capture.hits).toEqual([]);
    expect(capture.procHits).toEqual([]);
    await expectNowhere(artifacts, needles, capture);
    const saved = JSON.parse(await readFile(path.join(f.serviceHome, "auth.json"), "utf8"));
    expect(saved.tokens.refresh_token).toBe("REAL-REFRESH-2");
    expect(saved.tokens.access_token).toBe(fresh);
  });

  test("a failing refresh answers 502, reaches no upstream, keeps the login and leaks nothing (AC-4.4, 2.4)", async () => {
    const f = await fixture({
      login: chatgptRecord("ACCESS-OLD", { expiresIn: -HOUR }),
      token: (body) => ({ status: 400, body: JSON.stringify({ error: "invalid_grant", echoed: JSON.parse(body).refresh_token }) }),
    });
    const before = await readFile(path.join(f.serviceHome, "auth.json"));
    const { capture, artifacts } = await run(f, { requests: [{ path: "/responses" }] });

    expect(capture.responses).toEqual([{ status: 502, body: "credential unavailable" }]);
    expect(upstreamApiRequests(f)).toEqual([]);
    expect(await readFile(path.join(f.serviceHome, "auth.json"))).toEqual(before);
    await expectNowhere(artifacts, ["REAL-REFRESH-1"], capture);
  });

  test("a login that cannot be routed keeps its private copy and says so once (AC-1.4)", async () => {
    const unknown = JSON.stringify({ auth_mode: "agent-identity", tokens: { access_token: "UNROUTABLE-ACCESS" } });
    const f = await fixture({ login: unknown });
    const { capture } = await run(f, {});
    expect(capture.record).toBe(unknown);
    const warnings = records.filter((record) => record.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain("readable by the run's commands");
    expect(String(warnings[0]!.reason)).toContain("unsupported shape");
    expect(JSON.stringify(records)).not.toContain("UNROUTABLE-ACCESS");

    records.length = 0;
    const empty = await fixture({ login: {} });
    const emptyRun = await run(empty, {});
    expect(emptyRun.capture.record).toBe("{}");
    expect(records.filter((record) => record.level === "warn")).toHaveLength(1);

    records.length = 0;
    const noNetwork = await fixture({ login: { auth_mode: "apikey", OPENAI_API_KEY: "sk-fixture-REAL-KEY-1" } });
    const plain = await run(noNetwork, {}, { egress: false });
    expect(JSON.parse(plain.capture.record).OPENAI_API_KEY).toBe("sk-fixture-REAL-KEY-1");
    const plainWarnings = records.filter((record) => record.level === "warn");
    expect(plainWarnings).toHaveLength(1);
    expect(String(plainWarnings[0]!.reason)).toContain("no sandbox network");
    expect(JSON.stringify(records)).not.toContain("sk-fixture-REAL-KEY-1");
  });
});
