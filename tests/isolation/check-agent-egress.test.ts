import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import net from "node:net";
import path from "node:path";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { claudeCodeChecks, judgeLiveOutput, liveArguments, liveHosts, liveModeNote, livePrompt, loadCheckConfig, runLiveClaudeCheck, dockerSocketChecks, localServiceChecks, restoreSteps, runSandboxedCheck } from "../../scripts/check-agent-egress";
import { startEgressProxy, type EgressProxy } from "../../src/isolation/egress-proxy";
import { bwrapUnavailableReason } from "../support/bwrap";
import { shortTemporaryDirectory } from "../support/short-temporary-directory";

describe("restoreSteps", () => {
  test("uses an empty task-scoped cache for every ecosystem", () => {
    const steps = restoreSteps(["package-lock.json", "pubspec.yaml", "App.csproj", "gradlew", "requirements.txt"], "/scratch");
    expect(steps.map((step) => step.name)).toEqual(["npm", "flutter", "dotnet", "gradle", "pip"]);
    expect(steps[0]!.argv).toEqual(["npm", "ci", "--cache", "/scratch/npm"]);
    expect(steps[1]!.env).toEqual({ PUB_CACHE: "/scratch/pub" });
    expect(steps[2]!.argv).toContain("/scratch/nuget");
    expect(steps[3]!.argv).toEqual(["./gradlew", "--gradle-user-home", "/scratch/gradle", "help"]);
    expect(steps[4]!.argv).toContain("--no-cache-dir");
  });

  test("detects nothing for an unknown project", () => {
    expect(restoreSteps(["README.md"], "/scratch")).toEqual([]);
  });
});

describe("local service and Docker checks", () => {
  test("no local services adds no service checks", () => {
    expect(localServiceChecks([])).toEqual([]);
  });
});

describe("loadCheckConfig", () => {
  test("resolves builtin includes when the Conveyor home is given", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "egress-home-"));
    try {
      await mkdir(path.join(root, "config"), { recursive: true });
      const entrypoint = path.join(root, "config", "conveyor.yaml");
      await writeFile(entrypoint, `providers: !include builtin:providers.yaml
harnesses: !include builtin:harnesses.yaml
agents: !include builtin:agents.yaml
pipelines:
  delivery:
    stages: !include builtin:stages.yaml
repositories:
  app:
    items: github
    code: github
    ci: { mode: disabled }
    address: owner/app
    folder: ../repos/app
    pipeline: delivery
    agentEgress: { httpsHosts: [registry.npmjs.org] }
`);
      await expect(loadCheckConfig(entrypoint)).rejects.toThrow(/not available here/);
      const config = await loadCheckConfig(entrypoint, root);
      expect(config.repositories.app!.agentEgress?.httpsHosts).toEqual(["registry.npmjs.org"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("claudeCodeChecks", () => {
  const checks = claudeCodeChecks({ httpsHosts: ["registry.npmjs.org"], controlPlaneHosts: ["api.anthropic.com"] });
  const find = (text: string) => checks.find((check) => check.name.includes(text))!;

  test("the process reaches only its control-plane host and its commands only the allowed hosts", () => {
    expect(find("process reaches its control-plane host api.anthropic.com")).toMatchObject({ expectFailure: false });
    expect(find("process reaches its control-plane host").argv[2]).not.toContain("CLAUDE_CODE_SHELL_PREFIX");
    expect(find("process is refused non-control host registry.npmjs.org")).toMatchObject({ expectFailure: true });
    expect(find("command reaches allowed host registry.npmjs.org").argv[2]).toStartWith(`"$CLAUDE_CODE_SHELL_PREFIX" 'curl`);
    expect(find("command is refused the control-plane host")).toMatchObject({ expectFailure: true });
  });

  test("checks the GitHub API and direct IP denials for commands and the credential separation", () => {
    expect(find("command: api.github.com is refused").expectFailure).toBe(true);
    expect(find("command: direct IP connection is refused").argv[2]).toContain("--noproxy");
    expect(find("process: api.github.com is refused").expectFailure).toBe(true);
    expect(find("does not receive the control-plane credential").expectFailure).toBe(false);
  });
});

describe("claudeCodeChecks calling convention", () => {
  test("every prefixed probe passes the prefix exactly one quoted argument", () => {
    const prefixed = claudeCodeChecks({ httpsHosts: ["registry.npmjs.org"], controlPlaneHosts: ["api.anthropic.com"] }).filter((check) => check.argv[2]!.includes("CLAUDE_CODE_SHELL_PREFIX"));
    expect(prefixed.length).toBeGreaterThan(4);
    for (const check of prefixed) expect(check.argv[2]).toMatch(/^"\$CLAUDE_CODE_SHELL_PREFIX" '(?:[^']|'\\'')*'$/);
  });
});

describe("live Claude Code check", () => {
  const hosts = { allowed: "registry.fake.test", refused: "api.github.com" };
  const events = (allowedError: boolean, refusedError: boolean) => [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: `curl https://${hosts.allowed}` } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", is_error: allowedError }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "b", name: "Bash", input: { command: `curl https://${hosts.refused}` } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b", is_error: refusedError }] } },
  ].map((event) => JSON.stringify(event)).join("\n");

  test("picks an allowed non-control host and a refused host outside httpsHosts", () => {
    expect(liveHosts({ httpsHosts: ["api.github.com", "registry.npmjs.org"], controlPlaneHosts: ["api.anthropic.com"] })).toEqual({ allowed: "api.github.com", refused: "example.com" });
    expect(liveHosts({ httpsHosts: ["api.anthropic.com"], controlPlaneHosts: ["api.anthropic.com"] })).toBeUndefined();
    expect(livePrompt(hosts)).toContain(`https://${hosts.refused}`);
    expect(liveArguments()).toContain("stream-json");
  });

  test("passes only when the allowed command succeeds and the refused one fails", () => {
    expect(judgeLiveOutput(events(false, true), hosts)).toEqual({ passed: true, problems: [] });
    expect(judgeLiveOutput(events(true, true), hosts).passed).toBe(false);
    expect(judgeLiveOutput(events(false, false), hosts).problems.join()).toContain("must be refused");
    expect(judgeLiveOutput("", hosts).problems).toHaveLength(2);
  });

  const unavailableLive = bwrapUnavailableReason();
  test.skipIf(unavailableLive !== undefined)("starts the CLI binary in the run's namespace and fails when the refused command is not refused", async () => {
    const directory = await shortTemporaryDirectory("egress-live-", { socketPath: "artifacts/live-x/artifacts/net/control.sock", visibleInSandbox: true });
    const servers: net.Server[] = [];
    try {
      const cli = path.join(directory, "claude");
      // Stub CLI: runs both commands through the real command prefix (one string argument) and reports them as stream-json.
      await writeFile(cli, `#!/usr/bin/env bun
const prompt = await new Response(Bun.stdin.stream()).text();
const out = (event) => console.log(JSON.stringify(event));
const probe = (host) => 'bun -e \'const s=require("node:net").connect(Number(new URL(process.env.HTTPS_PROXY).port),"127.0.0.1");let r="";s.on("data",c=>{r+=c;process.exit(r.split(" ")[1]==="200"?0:1)});s.write("CONNECT ${"$"}{host}:443 HTTP/1.1\\r\\nHost: ${"$"}{host}:443\\r\\n\\r\\n")\'';
let id = 0;
for (const host of ["registry.fake.test", "api.github.com"]) {
  const key = String(id++);
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: key, name: "Bash", input: { command: "curl https://" + host } }] } });
  const result = Bun.spawnSync([process.env.CLAUDE_CODE_SHELL_PREFIX, probe(host).replaceAll("${"$"}{host}", host)], { env: process.env });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: key, is_error: result.exitCode !== 0 }] } });
}
if (!prompt.includes("registry.fake.test") || !process.argv.includes("Bash")) process.exit(3);
`);
      await chmod(cli, 0o755);
      const model = net.createServer((socket) => socket.on("error", () => {}));
      servers.push(model);
      await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
      const port = (model.address() as net.AddressInfo).port;
      const workspace = path.join(directory, "workspace");
      await mkdir(workspace);
      const egress = { httpsHosts: ["registry.fake.test"], resolve: async () => ["203.0.113.1"], dial: () => net.connect(port, "127.0.0.1") };
      const result = await runLiveClaudeCheck({ cli, scratch: directory, workspace, base: { PATH: process.env.PATH ?? "" }, egress, hosts: { allowed: "registry.fake.test", refused: "api.github.com" } });
      expect(result.problems).toEqual([]);
      expect(result.passed).toBe(true);
      const permissive = await runLiveClaudeCheck({ cli, scratch: directory, workspace, base: { PATH: process.env.PATH ?? "" }, egress: { ...egress, httpsHosts: ["registry.fake.test", "api.github.com"] }, hosts: { allowed: "registry.fake.test", refused: "api.github.com" } });
      expect(permissive.passed).toBe(false);
    } finally {
      for (const server of servers) server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const unavailable = bwrapUnavailableReason();
const describeSandbox = unavailable ? describe.skip : describe;
if (unavailable) console.warn(`SKIPPED sandbox tests: \`bwrap --unshare-net\` is unavailable (${unavailable})`);

describeSandbox("egress checks run in the real sandbox", () => {
  let directory: string;
  let proxy: EgressProxy;
  const servers: net.Server[] = [];

  beforeAll(async () => {
    directory = await shortTemporaryDirectory("egress-chk-", { socketPath: "data.sock", visibleInSandbox: true });
    proxy = await startEgressProxy({ socketPath: path.join(directory, "data.sock"), allowedHosts: [] });
  });

  afterAll(async () => {
    await proxy?.close();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  /** Listens on a Unix socket; `reply` makes it answer any request with a minimal HTTP response. */
  async function listen(name: string, reply = false): Promise<string> {
    const socketPath = path.join(directory, name);
    const server = net.createServer((client) => {
      client.on("error", () => {});
      if (reply) client.on("data", () => client.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK"));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    return socketPath;
  }

  const run = (check: ReturnType<typeof localServiceChecks>[number], localServices: { endpoint: string; socket: string }[]) =>
    runSandboxedCheck({ check, cwd: directory, base: { PATH: process.env.PATH ?? "" }, proxySocket: proxy.socketPath, localServices });

  test("probes each configured service at its sandbox endpoint", async () => {
    const postgres = { name: "postgres", endpoint: "127.0.0.1:54331", socket: await listen("pg.sock") };
    const redis = { name: "redis", endpoint: "127.0.0.1:54332", socket: await listen("redis.sock") };
    const checks = localServiceChecks([postgres, redis]);
    expect(checks.map((check) => check.name)).toEqual([
      "local service postgres is reachable at 127.0.0.1:54331",
      "local service redis is reachable at 127.0.0.1:54332",
    ]);
    for (const check of checks) {
      const result = await run(check, [postgres, redis]);
      expect(result.passed).toBe(true);
    }
  });

  test("an unreachable service fails its check", async () => {
    const missing = { name: "postgres", endpoint: "127.0.0.1:54333", socket: path.join(directory, "absent.sock") };
    const [check] = localServiceChecks([missing]);
    const result = await run(check!, [missing]);
    expect(result.passed).toBe(false);
  });

  test("a Docker socket that refuses connections passes the check", async () => {
    const absent = path.join(directory, "no-docker.sock");
    for (const check of dockerSocketChecks([absent])) {
      expect((await run(check, [])).passed).toBe(true);
    }
  });

  test("a Docker socket that accepts the connection fails the check", async () => {
    // Forwarding the stand-in as a service keeps it unmasked, so it is reachable like an exposed Docker socket.
    const docker = await listen("docker.sock", true);
    const exposed = { name: "docker", endpoint: "127.0.0.1:54334", socket: docker };
    for (const check of dockerSocketChecks([docker])) {
      const result = await run(check, [exposed]);
      expect(result.exitCode).toBe(0);
      expect(result.passed).toBe(false);
    }
  });
});

describe("liveModeNote", () => {
  test("states the real CLI was not exercised without --live and prints nothing with it", () => {
    expect(liveModeNote(false)).toMatch(/real Claude Code CLI was not exercised.*--live/);
    expect(liveModeNote(true)).toBeUndefined();
  });
});
