import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import net from "node:net";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  claudeCodeChecks, judgeLiveOutput, judgePiLiveOutput, liveCommand, liveArguments, liveFilesystemOptions, NOT_SIGNED_IN, liveHosts, liveModeNote, livePrompt, loadCheckConfig,
  PI_PROBE_PREFIX, piChecks, piCredentialCommand, piLiveArguments, piLiveCommands, piLivePrompt, runLiveClaudeCheck, runLivePiCheck, runPiCheck, unlistedHost,
  dockerSocketChecks, localServiceChecks, restoreSteps, runSandboxedCheck,
} from "../../scripts/check-agent-egress";
import { piProcessVariables } from "../../src/plugins/pi/pi";
import { installFakePi } from "../support/fake-pi";
import { startEgressProxy, type EgressProxy } from "../../src/isolation/egress-proxy";
import { bwrapUnavailableReason } from "../support/bwrap";
import { shortTemporaryDirectory } from "../support/short-temporary-directory";
import { agentFilesystemPlan, agentLaunchCommand } from "../../src/isolation/sandbox";
import { resolveBash } from "../../src/isolation/environment";

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

  test("checks an unlisted host and direct IP denials for commands and the credential separation", () => {
    expect(find("command: unlisted api.github.com is refused").expectFailure).toBe(true);
    expect(find("command: direct IP connection is refused").argv[2]).toContain("--noproxy");
    expect(find("process: unlisted api.github.com is refused").expectFailure).toBe(true);
    expect(find("does not receive the control-plane credential").expectFailure).toBe(false);
  });
});

describe("unlistedHost", () => {
  test("is api.github.com unless the configuration lists it, then example.com", () => {
    expect(unlistedHost({ httpsHosts: ["registry.npmjs.org"], controlPlaneHosts: [] })).toBe("api.github.com");
    expect(unlistedHost({ httpsHosts: ["api.github.com"], controlPlaneHosts: [] })).toBe("example.com");
    expect(unlistedHost({ httpsHosts: [], controlPlaneHosts: ["api.github.com"] })).toBe("example.com");
  });

  test("probes the host the operator did not list", () => {
    const checks = piChecks({ httpsHosts: ["registry.npmjs.org"], controlPlaneHosts: ["api.github.com", "api.githubcopilot.com"], unset: [] });
    expect(checks.find((check) => check.name === "pi process: unlisted example.com is refused")).toMatchObject({ expectFailure: true });
    expect(checks.some((check) => check.name.includes("unlisted api.github.com"))).toBe(false);
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
    { type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: liveCommand(hosts.allowed) } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", is_error: allowedError }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "b", name: "Bash", input: { command: liveCommand(hosts.refused) } }] } },
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

  const notSignedInOutput = [
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] }, error: "authentication_failed" },
    { type: "result", is_error: true, result: "Not logged in · Please run /login" },
  ].map((event) => JSON.stringify(event)).join("\n");

  test("reports a Claude CLI that is not signed in, not a missing Bash command", () => {
    const verdict = judgeLiveOutput(notSignedInOutput, hosts);
    expect(verdict).toEqual({ passed: false, problems: [NOT_SIGNED_IN] });
    expect(NOT_SIGNED_IN).toBe("the Claude Code CLI is not signed in");
    expect(verdict.problems.join()).not.toContain("no completed Bash command");
    expect(judgeLiveOutput("", hosts).problems.join()).toContain("no completed Bash command");
  });

  describe("launch environment", () => {
    const parts = async () => {
      const root = await mkdtemp(path.join(tmpdir(), "live-env-"));
      const dirs = Object.fromEntries(["workspace", "artifacts", "home", "scratch", "config", "service/.claude"].map((name) => [name, path.join(root, name)]));
      await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));
      return { root, dirs };
    };
    const common = (dirs: Record<string, string>) => ({ cli: "/bin/sh", base: { PATH: "/usr/bin:/bin" }, workspace: dirs.workspace!, artifacts: dirs.artifacts!, home: dirs.home!, scratch: dirs.scratch! });

    test("passes the runner's configDir as CLAUDE_CONFIG_DIR and mounts it writable", async () => {
      const { root, dirs } = await parts();
      try {
        const options = liveFilesystemOptions({ ...common(dirs), configDir: dirs.config!, serviceHome: path.join(root, "service") });
        expect(options.env.CLAUDE_CONFIG_DIR).toBe(dirs.config!);
        expect(options.env.HOME).toBe(dirs.home!);
        expect(options.writable).toEqual([dirs.config!]);
        const mounts = agentFilesystemPlan(options).mounts;
        const at = mounts.findIndex((mount, index) => mount === dirs.config! && mounts[index + 1] === dirs.config!);
        expect(mounts[at - 1]).toBe("--bind");
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    test("falls back to the service account's ~/.claude without a configDir", async () => {
      const { root, dirs } = await parts();
      try {
        const options = liveFilesystemOptions({ ...common(dirs), serviceHome: path.join(root, "service") });
        expect(options.env.CLAUDE_CONFIG_DIR).toBe(dirs["service/.claude"]!);
        expect(options.writable).toEqual([dirs["service/.claude"]!]);
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    test("passes the OAuth token and API key from the environment", async () => {
      const { root, dirs } = await parts();
      try {
        const options = liveFilesystemOptions({ ...common(dirs), serviceHome: root, credentials: { CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: "key" } });
        expect(options.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: "key" });
      } finally { await rm(root, { recursive: true, force: true }); }
    });

    test("names the command and the PATH searched when the runner command is not installed", async () => {
      const { root, dirs } = await parts();
      try {
        const options = liveFilesystemOptions({ ...common(dirs), cli: "claude-missing", configDir: dirs.config!, base: { PATH: "/nowhere/bin" } });
        expect(() => agentLaunchCommand(options)).toThrow(/not installed: claude-missing \(searched PATH: \/nowhere\/bin\)/);
        expect(() => agentFilesystemPlan(options)).toThrow(/claude-missing.*\/nowhere\/bin/);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  });

  test("ignores commands the CLI changed from the ones it was asked to run", () => {
    const call = (id: string, command: string, isError: boolean) => [
      { type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError }] } },
    ];
    const swapped = [...call("a", `echo ${hosts.allowed}`, false), ...call("b", `echo ${hosts.refused}; exit 1`, true)].map((event) => JSON.stringify(event)).join("\n");
    const verdict = judgeLiveOutput(swapped, hosts);
    expect(verdict.passed).toBe(false);
    expect(verdict.problems).toHaveLength(2);
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
for (const line of prompt.split("\n").filter((line) => /^[12]\. /.test(line))) {
  const command = line.slice(3);
  const host = new URL(command.slice(command.indexOf("https://"))).hostname;
  const key = String(id++);
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: key, name: "Bash", input: { command } }] } });
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
      await mkdir(path.join(directory, "claude-config"));
      const egress = { httpsHosts: ["registry.fake.test"], resolve: async () => ["203.0.113.1"], dial: () => net.connect(port, "127.0.0.1") };
      const result = await runLiveClaudeCheck({ cli, scratch: directory, workspace, base: { PATH: process.env.PATH ?? "", SHELL: resolveBash()! }, egress, hosts: { allowed: "registry.fake.test", refused: "api.github.com" }, configDir: path.join(directory, "claude-config") });
      expect(result.problems).toEqual([]);
      expect(result.passed).toBe(true);
      const permissive = await runLiveClaudeCheck({ cli, scratch: directory, workspace, base: { PATH: process.env.PATH ?? "", SHELL: resolveBash()! }, egress: { ...egress, httpsHosts: ["registry.fake.test", "api.github.com"] }, hosts: { allowed: "registry.fake.test", refused: "api.github.com" }, configDir: path.join(directory, "claude-config") });
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

describe("pi checks", () => {
  const unset = ["PI_CODING_AGENT_DIR", "EXAMPLE_API_KEY"];
  const checks = piChecks({ httpsHosts: ["registry.npmjs.org"], controlPlaneHosts: ["api.anthropic.com"], unset });
  const find = (text: string) => checks.find((check) => check.name.includes(text))!;

  test("the process reaches only its control-plane host and its commands, run as pi runs them, only the allowed hosts", () => {
    expect(find("pi process reaches its control-plane host api.anthropic.com")).toMatchObject({ expectFailure: false });
    expect(find("pi process reaches its control-plane host").argv[2]).not.toContain(PI_PROBE_PREFIX);
    expect(find("pi process is refused non-control host registry.npmjs.org")).toMatchObject({ expectFailure: true });
    expect(find("pi command reaches allowed host registry.npmjs.org").argv[2]).toBe(`"$SHELL" -c "$${PI_PROBE_PREFIX}"'\ncurl -sS --max-time 15 -o /dev/null '\\''https://registry.npmjs.org'\\'''`);
    expect(find("pi command is refused the control-plane host")).toMatchObject({ expectFailure: true });
    expect(find("pi command: unlisted api.github.com is refused").expectFailure).toBe(true);
    expect(find("pi command: direct IP connection is refused").argv[2]).toContain("--noproxy");
    expect(find("pi process: unlisted api.github.com is refused").expectFailure).toBe(true);
  });

  test("a command must lose pi's agent directory, the runner's credentials and the control-plane credential", () => {
    expect(piCredentialCommand(unset)).toBe('test -z "${PI_CODING_AGENT_DIR+x}${EXAMPLE_API_KEY+x}" && case "$HTTPS_PROXY" in *conveyor:*) exit 1;; esac');
    expect(find("does not receive the agent directory").argv[2]).toContain(piCredentialCommand(unset));
    expect(find("does not receive the agent directory").expectFailure).toBe(false);
  });

  test("states the real pi CLI was not exercised without --live", () => {
    expect(liveModeNote(false, "pi")).toMatch(/real pi CLI was not exercised.*--live before turning on agentEgress for pi agents/);
  });
});

describe("live pi check", () => {
  const hosts = { allowed: "registry.fake.test", refused: "api.github.com" };
  const commands = piLiveCommands({ hosts, control: "model.fake.test", unset: ["PI_CODING_AGENT_DIR"] });
  const events = (outcomes: boolean[], stopReason = "stop") => [
    ...commands.flatMap((entry, index) => [
      { type: "tool_execution_start", toolCallId: String(index), toolName: "bash", args: { command: entry.command } },
      { type: "tool_execution_end", toolCallId: String(index), toolName: "bash", isError: !outcomes[index] },
    ]),
    { type: "message_end", message: { role: "assistant", stopReason, errorMessage: stopReason === "error" ? "401 invalid x-api-key" : undefined } },
  ].map((event) => JSON.stringify(event)).join("\n");

  test("asks for an allowed, a refused and a control-plane host and the credential check, in that order", () => {
    expect(commands.map((entry) => [entry.command, entry.succeeds])).toEqual([
      [liveCommand("registry.fake.test"), true],
      [liveCommand("api.github.com"), false],
      [liveCommand("model.fake.test"), false],
      [piCredentialCommand(["PI_CODING_AGENT_DIR"]), true],
    ]);
    const prompt = piLivePrompt(commands);
    expect(prompt).toContain("exactly 4 times");
    expect(prompt).toContain(`3. ${liveCommand("model.fake.test")}`);
    expect(piLiveArguments({ provider: "anthropic", model: "claude-opus-5-5" })).toEqual(expect.arrayContaining(["--mode", "json", "--no-session", "--tools", "bash", "--provider", "anthropic", "--model", "claude-opus-5-5"]));
    expect(piLiveArguments({ provider: "anthropic" })).not.toContain("--provider");
  });

  test("passes only when the model answered and every command behaved as required", () => {
    expect(judgePiLiveOutput(events([true, false, false, true]), commands)).toEqual({ passed: true, problems: [] });
    expect(judgePiLiveOutput(events([true, true, false, true]), commands).problems).toEqual([`the bash command that is refused api.github.com succeeded: ${liveCommand("api.github.com")}`]);
    expect(judgePiLiveOutput(events([true, false, true, true]), commands).passed).toBe(false);
    expect(judgePiLiveOutput(events([true, false, false, false]), commands).problems.join()).toContain("does not receive pi's agent directory or credentials failed");
  });

  test("reports a model pi could not reach instead of missing commands", () => {
    expect(judgePiLiveOutput(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "401 invalid x-api-key" } }), commands))
      .toEqual({ passed: false, problems: ["pi did not reach its model: 401 invalid x-api-key"] });
    expect(judgePiLiveOutput("", commands).problems).toEqual(["pi did not reach its model"]);
  });

  test("ignores commands pi changed from the ones it was asked to run", () => {
    const changed = commands.map((entry, index) => [
      { type: "tool_execution_start", toolCallId: String(index), toolName: "bash", args: { command: `${entry.command} || true` } },
      { type: "tool_execution_end", toolCallId: String(index), toolName: "bash", isError: false },
    ]).flat().concat([{ type: "message_end", message: { role: "assistant", stopReason: "stop" } } as never]).map((event) => JSON.stringify(event)).join("\n");
    expect(judgePiLiveOutput(changed, commands).problems).toHaveLength(4);
  });

  const unavailablePi = bwrapUnavailableReason();
  test.skipIf(unavailablePi !== undefined)("runs pi's probes as the runner launches pi: its commands source the command environment", async () => {
    const directory = await shortTemporaryDirectory("egress-pi-", { socketPath: "pi-x/artifacts/net/control.sock", visibleInSandbox: true });
    try {
      const workspace = path.join(directory, "workspace");
      await mkdir(workspace);
      const base = { PATH: process.env.PATH ?? "", SHELL: resolveBash()! };
      const egress = { httpsHosts: ["registry.fake.test"], resolve: async () => ["203.0.113.1"], dial: () => net.connect(9, "127.0.0.1") };
      const credentialCheck = piChecks({ httpsHosts: [], controlPlaneHosts: [], unset: piProcessVariables(["EXAMPLE_API_KEY"]) }).find((check) => check.name.includes("does not receive"))!;
      const processHolds = { name: "the process holds its credentials", argv: ["sh", "-c", 'test -n "$EXAMPLE_API_KEY" && test -n "$PI_CODING_AGENT_DIR" && case "$HTTPS_PROXY" in *conveyor:*) exit 0;; esac; exit 1'], expectFailure: false };
      for (const check of [credentialCheck, processHolds]) {
        const result = await runPiCheck({ check, scratch: directory, workspace, base, egress, controlPlaneHosts: ["model.fake.test"], credentialVariables: ["EXAMPLE_API_KEY"] });
        expect({ name: check.name, passed: result.passed, output: result.passed ? "" : result.output }).toEqual({ name: check.name, passed: true, output: "" });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.skipIf(unavailablePi !== undefined)("starts pi in the run's namespace with a private copy of the runner's login, and fails when a refused command is not refused", async () => {
    const directory = await shortTemporaryDirectory("egress-pl-", { socketPath: "live-pi-x/artifacts/net/control.sock", visibleInSandbox: true });
    const servers: net.Server[] = [];
    try {
      const workspace = path.join(directory, "workspace");
      const service = path.join(directory, "service-pi");
      await Promise.all([mkdir(workspace), mkdir(service)]);
      await writeFile(path.join(service, "auth.json"), '{"old":true}');
      // Run inside the namespace instead of curl: CONNECT through the command's proxy, exit 0 on 200.
      const probe = path.join(workspace, "probe.js");
      await writeFile(probe, [
        "const host = process.argv[2];",
        'const s = require("node:net").connect(Number(new URL(process.env.HTTPS_PROXY).port), "127.0.0.1");',
        'let r = "";',
        's.on("data", (c) => { r += c; process.exit(r.split(" ")[1] === "200" ? 0 : 1); });',
        "s.on(\"error\", () => process.exit(2));",
        's.write("CONNECT " + host + ":443 HTTP/1.1\\r\\nHost: " + host + ":443\\r\\n\\r\\n");',
      ].join("\n"));
      // Stub pi: refreshes its login, runs each numbered command as pi's bash tool does and reports pi's JSON events.
      const { command: cli } = await installFakePi(path.join(directory, "install"), [
        'import { readFileSync, writeFileSync } from "node:fs";',
        "const prompt = await Bun.stdin.text();",
        "const out = (event) => console.log(JSON.stringify(event));",
        "const agentDir = process.env.PI_CODING_AGENT_DIR;",
        'const settings = JSON.parse(readFileSync(agentDir + "/settings.json", "utf8"));',
        'writeFileSync(agentDir + "/auth.json", JSON.stringify({ refreshed: true }));',
        "const nl = String.fromCharCode(10);",
        "let id = 0;",
        "for (const line of prompt.split(nl).filter((line) => /^[0-9]+[.] /.test(line))) {",
        '  const command = line.slice(line.indexOf(" ") + 1);',
        "  const url = command.match(/https:[/][/]([^ ]+)/);",
        `  const run = url ? '"' + process.execPath + '" ${probe} ' + url[1] : command;`,
        "  const key = String(id++);",
        '  out({ type: "tool_execution_start", toolCallId: key, toolName: "bash", args: { command } });',
        "  const result = Bun.spawnSync([settings.shellPath, \"-c\", settings.shellCommandPrefix + nl + run], { env: process.env });",
        '  out({ type: "tool_execution_end", toolCallId: key, toolName: "bash", isError: result.exitCode !== 0 });',
        "}",
        'out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } });',
        'if (!process.argv.includes("bash") || !process.argv.includes("--no-session")) process.exit(3);',
      ].join("\n"));
      const model = net.createServer((socket) => socket.on("error", () => {}));
      servers.push(model);
      await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
      const port = (model.address() as net.AddressInfo).port;
      const egress = { httpsHosts: ["registry.fake.test"], resolve: async () => ["203.0.113.1"], dial: () => net.connect(port, "127.0.0.1") };
      const common = {
        cli, scratch: directory, workspace, base: { PATH: process.env.PATH ?? "", SHELL: resolveBash()! }, controlPlaneHosts: ["model.fake.test"],
        hosts: { allowed: "registry.fake.test", refused: "api.github.com" }, serviceDirectory: service, credentials: { EXAMPLE_API_KEY: "secret" },
      };
      const result = await runLivePiCheck({ ...common, egress });
      expect(result.problems).toEqual([]);
      expect(result.passed).toBe(true);
      // The login pi refreshed goes back to the service, as after a run.
      expect(JSON.parse(await readFile(path.join(service, "auth.json"), "utf8"))).toEqual({ refreshed: true });
      const permissive = await runLivePiCheck({ ...common, egress: { ...egress, httpsHosts: ["registry.fake.test", "api.github.com"] } });
      expect(permissive.passed).toBe(false);
      expect(permissive.problems).toEqual([`the bash command that is refused api.github.com succeeded: ${liveCommand("api.github.com")}`]);
    } finally {
      for (const server of servers) server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
