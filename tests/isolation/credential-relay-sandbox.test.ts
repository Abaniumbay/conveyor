import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import type { ConveyorConfig } from "../../src/config/load";
import { agentEgressFor } from "../../src/isolation/agent-egress";
import { startRunNetwork, type AgentNetworkPolicy, type RunNetwork } from "../../src/isolation/run-network";
import { bwrapUnavailableReason } from "../support/bwrap";
import { startRelayUpstream, throwawayCertificate, type RelayUpstream } from "../support/relay-upstream";
import { shortTemporaryDirectory } from "../support/short-temporary-directory";

const unavailable = bwrapUnavailableReason();
const describeSandbox = unavailable ? describe.skip : describe;
if (unavailable) console.warn(`SKIPPED credential relay sandbox tests: \`bwrap --unshare-net\` is unavailable (${unavailable})`);
setDefaultTimeout(30_000);

interface Step {
  port: number;
  raw: string;
}

interface ProbeResult {
  responses: string[];
  env: Record<string, string>;
  processes: Array<{ cmdline: string; user: string; net: string }>;
}

// Runs inside the sandbox: sends each raw request to a loopback port and prints what came back.
const PROBE = `
  const net = require("node:net");
  const fs = require("node:fs");
  const spec = JSON.parse(process.argv[1]);
  const exchange = (step) => new Promise((resolve) => {
    const socket = net.connect(step.port, "127.0.0.1");
    let raw = "";
    const finish = () => { clearTimeout(timer); socket.destroy(); resolve(raw); };
    const timer = setTimeout(finish, 4000);
    socket.on("connect", () => socket.write(step.raw));
    socket.on("data", (chunk) => { raw += chunk.toString(); if (step.raw.startsWith("CONNECT") && raw.includes("\\r\\n\\r\\n")) finish(); });
    socket.on("close", finish);
    socket.on("error", (error) => { raw += "ERROR " + error.code; finish(); });
  });
  (async () => {
    const responses = [];
    for (const step of spec.steps) responses.push(await exchange(step));
    const processes = [];
    if (spec.inspect) {
      for (const pid of fs.readdirSync("/proc").filter((name) => /^[0-9]+$/.test(name))) {
        try {
          processes.push({
            cmdline: fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").replaceAll("\\0", " "),
            user: fs.readlinkSync("/proc/" + pid + "/ns/user"),
            net: fs.readlinkSync("/proc/" + pid + "/ns/net"),
          });
        } catch {}
      }
    }
    console.log(JSON.stringify({ responses, env: process.env, processes }));
  })();
`;

async function probe(network: RunNetwork, steps: Step[], options: { inspect?: boolean } = {}): Promise<ProbeResult> {
  const sandboxed = network.wrap({ PATH: process.env.PATH ?? "" }, () => [process.execPath, "-e", PROBE, JSON.stringify({ steps, ...options })]);
  const child = Bun.spawn(sandboxed.argv, { env: sandboxed.env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`probe exited ${code}: ${err}`);
  return JSON.parse(out) as ProbeResult;
}

function relayPort(network: RunNetwork): number {
  return Number(new URL(network.relay!.url).port);
}

function dataPort(network: RunNetwork): number {
  return Number(new URL(network.wrap({}, () => ["true"]).dataEnv.HTTPS_PROXY!).port);
}

function get(pathname: string, headers: Record<string, string>, method = "GET"): string {
  const lines = Object.entries({ Host: "relay.example.com", Connection: "close", ...headers }).map(([name, value]) => `${name}: ${value}`);
  return `${method} ${pathname} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const statusOf = (response: string) => Number(/^HTTP\/1\.1 (\d+)/.exec(response)?.[1] ?? 0);
const bodyOf = (response: string) => response.slice(response.indexOf("\r\n\r\n") + 4);

describeSandbox("credential relay in a real bubblewrap run", () => {
  let directory: string;
  let certificate: Awaited<ReturnType<typeof throwawayCertificate>>;
  let server: RelayUpstream;
  let credential = "real-secret-1";
  let reads = 0;
  const networks: RunNetwork[] = [];
  const extras: Array<() => Promise<void>> = [];
  let counter = 0;

  async function start(policy: Partial<AgentNetworkPolicy> = {}): Promise<RunNetwork> {
    const network = await startRunNetwork({
      directory: path.join(directory, `n${counter++}`),
      policy: {
        httpsHosts: [],
        controlPlaneHosts: [],
        relay: { upstream: `https://localhost:${server.port}/v1`, credential: () => { reads += 1; return credential; }, ca: certificate.cert },
        ...policy,
      },
    });
    networks.push(network);
    return network;
  }

  beforeAll(async () => {
    directory = await shortTemporaryDirectory("conveyor-relay-sb-", { socketPath: "n10/control.sock", visibleInSandbox: true });
    certificate = await throwawayCertificate();
    server = await startRelayUpstream(certificate);
  });

  beforeEach(() => {
    credential = "real-secret-1";
    reads = 0;
    server.requests.length = 0;
  });

  afterEach(async () => {
    for (const cleanup of extras.splice(0)) await cleanup();
  });

  afterAll(async () => {
    await Promise.all(networks.map((network) => network.close()));
    await server?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test("a sandboxed process reaches the upstream through the run's loopback relay endpoint over TLS", async () => {
    const network = await start();
    const { responses } = await probe(network, [{
      port: relayPort(network),
      raw: get("/messages?x=1", { ...bearer(network.relay!.placeholder), "Content-Length": "7" }, "POST").replace(/\r\n\r\n$/, '\r\n\r\n{"a":1}'),
    }]);
    expect(statusOf(responses[0]!)).toBe(200);
    expect(bodyOf(responses[0]!)).toContain("upstream-ok");
    expect(server.requests.map(({ method, url, body }) => ({ method, url, body }))).toEqual([{ method: "POST", url: "/v1/messages?x=1", body: '{"a":1}' }]);
  });

  test("the base path, method, query and streamed body are carried, and the request cannot escape the base path or change the host", async () => {
    const network = await start();
    const auth = bearer(network.relay!.placeholder);
    const { responses } = await probe(network, [
      { port: relayPort(network), raw: get("/stream", auth) },
      { port: relayPort(network), raw: get("/../admin", auth) },
      { port: relayPort(network), raw: get("/models", { ...auth, Host: "evil.example.com" }) },
    ]);
    expect(responses[0]).toContain("chunk-one;");
    expect(responses[0]).toContain("chunk-two");
    expect(statusOf(responses[1]!)).toBeGreaterThanOrEqual(400);
    expect(server.requests.map((request) => request.url)).toEqual(["/v1/stream", "/v1/models"]);
    expect(server.requests[1]?.host).toBe(`localhost:${server.port}`);
  });

  test("the upstream receives the real credential in place of the placeholder", async () => {
    const network = await start();
    await probe(network, [{ port: relayPort(network), raw: get("/models", bearer(network.relay!.placeholder)) }]);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.headers.authorization).toBe("Bearer real-secret-1");
    expect(JSON.stringify(server.requests[0]?.headers)).not.toContain(network.relay!.placeholder);
  });

  test("the credential source is read for every forwarded request, so a rotated credential is used at once", async () => {
    const network = await start();
    const auth = bearer(network.relay!.placeholder);
    await probe(network, [{ port: relayPort(network), raw: get("/models", auth) }]);
    credential = "real-secret-2";
    await probe(network, [{ port: relayPort(network), raw: get("/models", auth) }]);
    expect(server.requests.map((request) => request.headers.authorization)).toEqual(["Bearer real-secret-1", "Bearer real-secret-2"]);
    expect(reads).toBe(2);
  });

  test("the real credential never enters the sandbox: not its environment, the wrapped argv and env, or any response", async () => {
    const network = await start();
    const sandboxed = network.wrap({ PATH: process.env.PATH ?? "" }, () => ["true"]);
    const auth = bearer(network.relay!.placeholder);
    const result = await probe(network, [
      { port: relayPort(network), raw: get("/models", auth) },
      { port: relayPort(network), raw: get("/error", auth) },
    ]);
    expect(statusOf(result.responses[1]!)).toBe(500);
    expect(JSON.stringify(result)).not.toContain("real-secret-1");
    expect(JSON.stringify({ argv: sandboxed.argv, env: sandboxed.env })).not.toContain("real-secret-1");
    expect(result.env.CONVEYOR_RELAY_PLACEHOLDER).toBe(network.relay!.placeholder);
    expect(network.relay!.placeholder).not.toBe("real-secret-1");
    expect(sandboxed.env.CONVEYOR_RELAY_URL).toBe(network.relay!.url);
  });

  describe("credentials other than the run's placeholder", () => {
    let outcomes: Map<string, string>;
    let reachedUpstream: number;
    const names = ["wrong", "the real credential", "another run's placeholder", "an empty bearer", "a lookalike", "a prefix", "Basic scheme", "no header"];

    beforeAll(async () => {
      const network = await start();
      const other = await start();
      const placeholder = network.relay!.placeholder;
      const headers: Array<Record<string, string>> = [
        bearer("wrong"),
        bearer("real-secret-1"),
        bearer(other.relay!.placeholder),
        { Authorization: "Bearer " },
        bearer(`${placeholder}x`),
        bearer(placeholder.slice(0, -1)),
        { Authorization: `Basic ${placeholder}` },
        {},
      ];
      server.requests.length = 0;
      const { responses } = await probe(network, [
        ...headers.map((header) => ({ port: relayPort(network), raw: get("/models", header) })),
        { port: relayPort(network), raw: get("/models", bearer(placeholder)) },
      ]);
      reachedUpstream = server.requests.length;
      outcomes = new Map([...names.map((name, index) => [name, responses[index]!] as const), ["the placeholder", responses[names.length]!]]);
    });

    test.each(names)("%s is rejected with a generic body", (name) => {
      const response = outcomes.get(name)!;
      expect([401, 403]).toContain(statusOf(response));
      expect(bodyOf(response)).not.toContain("real-secret-1");
    });

    test("none of them reached the upstream, and the placeholder still works afterwards", () => {
      expect(statusOf(outcomes.get("the placeholder")!)).toBe(200);
      // Only the final request, which carried the placeholder, got through.
      expect(reachedUpstream).toBe(1);
    });
  });

  test("a credential the client puts in another header is not forwarded", async () => {
    const network = await start();
    await probe(network, [{ port: relayPort(network), raw: get("/models", { ...bearer(network.relay!.placeholder), "x-api-key": "attacker-key", Cookie: "s=1" }) }]);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.headers.authorization).toBe("Bearer real-secret-1");
    expect(JSON.stringify(server.requests[0]?.headers)).not.toContain("attacker-key");
    expect(server.requests[0]?.headers.cookie).toBeUndefined();
  });

  describe("a run without agentEgress", () => {
    const config = { web: { listen: "127.0.0.1:8123" }, settings: { artifacts: "/data/artifacts" }, repositories: { legacy: {} } } as unknown as ConveyorConfig;

    test("gets a policy that carries the relay with empty allowlists, and stays unsandboxed without one", async () => {
      const relay = { upstream: `https://localhost:${server.port}/v1`, credential: () => credential, ca: certificate.cert };
      const policy = agentEgressFor(config, "legacy", { relay });
      expect(policy).toMatchObject({ httpsHosts: [], relay });
      expect(policy?.controlPlaneHosts ?? []).toEqual([]);
      expect(agentEgressFor(config, "legacy", {})).toBeUndefined();
      const network = await start({ ...policy!, controlPlaneHosts: policy!.controlPlaneHosts ?? [] });
      await probe(network, [{ port: relayPort(network), raw: get("/models", bearer(network.relay!.placeholder)) }]);
      expect(server.requests[0]?.headers.authorization).toBe("Bearer real-secret-1");
    });

    test("opens no other route out: undeclared host listeners are unreachable and CONNECT is refused", async () => {
      const undeclared = net.createServer();
      await new Promise<void>((resolve) => undeclared.listen(0, "127.0.0.1", resolve));
      extras.push(() => new Promise<void>((resolve) => undeclared.close(() => resolve())));
      const network = await start();
      const { responses } = await probe(network, [
        { port: (undeclared.address() as net.AddressInfo).port, raw: "ping" },
        { port: dataPort(network), raw: "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n" },
      ]);
      expect(responses[0]).toContain("ERROR ECONNREFUSED");
      expect(statusOf(responses[1]!)).toBe(403);
    });
  });

  describe("a run with agentEgress", () => {
    async function egressNetwork(dialed: string[]): Promise<RunNetwork> {
      const allowed = net.createServer((socket) => socket.on("error", () => {}));
      await new Promise<void>((resolve) => allowed.listen(0, "127.0.0.1", resolve));
      extras.push(() => new Promise<void>((resolve) => allowed.close(() => resolve())));
      return start({
        httpsHosts: ["allowed.example.com"],
        controlPlaneHosts: ["model.example.com"],
        relay: { upstream: `https://localhost:${server.port}/v1`, credential: () => credential, ca: certificate.cert },
        resolve: async () => ["203.0.113.1"],
        dial: (address) => {
          dialed.push(address);
          return net.connect((allowed.address() as net.AddressInfo).port, "127.0.0.1");
        },
      });
    }
    const connect = (target: string): string => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;

    test("the relay works next to the allowlist proxies, which still serve their allowed host", async () => {
      const dialed: string[] = [];
      const network = await egressNetwork(dialed);
      const { responses } = await probe(network, [
        { port: relayPort(network), raw: get("/models", bearer(network.relay!.placeholder)) },
        { port: dataPort(network), raw: connect("allowed.example.com:443") },
      ]);
      expect(statusOf(responses[0]!)).toBe(200);
      expect(server.requests[0]?.headers.authorization).toBe("Bearer real-secret-1");
      expect(responses[1]).toContain("200 Connection Established");
    });

    test("other hosts, the relay's own upstream host and IP literals are still refused without dialing", async () => {
      const dialed: string[] = [];
      const network = await egressNetwork(dialed);
      const { responses } = await probe(network, [
        { port: dataPort(network), raw: connect("other.example.com:443") },
        { port: dataPort(network), raw: connect("relay-upstream.example.com:443") },
        { port: dataPort(network), raw: connect("203.0.113.9:443") },
      ]);
      expect(responses.map(statusOf)).toEqual([403, 403, 403]);
      expect(dialed).toEqual([]);
    });

    test("the relay is not an open proxy: absolute-form targets and CONNECT never reach another host", async () => {
      const other = await startRelayUpstream();
      extras.push(() => other.close());
      const network = await start();
      const auth = bearer(network.relay!.placeholder);
      const { responses } = await probe(network, [
        { port: relayPort(network), raw: get(`https://localhost:${other.port}/`, auth) },
        { port: relayPort(network), raw: get(`//localhost:${other.port}/`, auth) },
        { port: relayPort(network), raw: `CONNECT localhost:${other.port} HTTP/1.1\r\nHost: localhost:${other.port}\r\n${Object.entries(auth).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n` },
      ]);
      expect(responses.map(statusOf).every((status) => status >= 400 && status < 500)).toBe(true);
      expect(other.connections()).toBe(0);
      expect(other.requests).toEqual([]);
      expect(server.requests).toEqual([]);
    });
  });

  test("the relay stops accepting requests when the run ends, and closing twice is safe", async () => {
    const network = await start();
    const socket = path.join(directory, `n${counter - 1}`, "relay.sock");
    await probe(network, [{ port: relayPort(network), raw: get("/models", bearer(network.relay!.placeholder)) }]);
    expect(server.requests).toHaveLength(1);
    await network.close();
    await network.close();
    expect(await Bun.file(socket).exists()).toBe(false);
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => net.connect(socket).once("error", resolve));
    expect(["ENOENT", "ECONNREFUSED"]).toContain(error.code!);
    expect(server.requests).toHaveLength(1);
  });

  test("a placeholder is random per run and a run rejects another run's placeholder, finished or alive", async () => {
    const first = await start();
    const p1 = first.relay!.placeholder;
    await first.close();
    const second = await start();
    const third = await start();
    const [p2, p3] = [second.relay!.placeholder, third.relay!.placeholder];
    expect(new Set([p1, p2, p3]).size).toBe(3);
    for (const placeholder of [p1, p2, p3]) {
      expect(placeholder.length).toBeGreaterThanOrEqual(32);
      expect(placeholder).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(placeholder).not.toBe("real-secret-1");
    }
    const { responses } = await probe(second, [
      { port: relayPort(second), raw: get("/models", bearer(p1)) },
      { port: relayPort(second), raw: get("/models", bearer(p3)) },
      { port: relayPort(second), raw: get("/models", bearer(p2)) },
    ]);
    expect([statusOf(responses[0]!), statusOf(responses[1]!), statusOf(responses[2]!)]).toEqual([401, 401, 200]);
    expect(server.requests).toHaveLength(1);
    const alive = await probe(third, [{ port: relayPort(third), raw: get("/models", bearer(p2)) }]);
    expect(statusOf(alive.responses[0]!)).toBe(401);
    expect(server.requests).toHaveLength(1);
  });

  test("the run uses one bubblewrap and one user and network namespace", async () => {
    const network = await start();
    const sandboxed = network.wrap({ PATH: process.env.PATH ?? "" }, () => ["true"]);
    const flags = sandboxed.argv.filter((argument) => argument.startsWith("--"));
    expect(sandboxed.argv.filter((argument) => path.basename(argument) === "bwrap")).toHaveLength(1);
    expect(flags.filter((flag) => flag === "--unshare-net")).toHaveLength(1);
    for (const forbidden of ["--unshare-user", "--unshare-user-try", "--unshare-all", "--userns", "--unshare-ipc"]) expect(flags).not.toContain(forbidden);
    const result = await probe(network, [{ port: relayPort(network), raw: get("/models", bearer(network.relay!.placeholder)) }], { inspect: true });
    expect(statusOf(result.responses[0]!)).toBe(200);
    expect(result.processes.length).toBeGreaterThan(0);
    expect(new Set(result.processes.map((entry) => entry.user)).size).toBe(1);
    expect(new Set(result.processes.map((entry) => entry.net)).size).toBe(1);
    // The one bwrap is the sandbox's own init; no further bubblewrap runs inside it.
    expect(result.processes.filter((entry) => /(^|\/)bwrap\b/.test(entry.cmdline.split(" ")[0] ?? "")).length).toBeLessThanOrEqual(1);
  });
});
