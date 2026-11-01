import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import net from "node:net";
import path from "node:path";
import { rm } from "node:fs/promises";

import { claudeCodeChecks, dockerSocketChecks, localServiceChecks, restoreSteps, runSandboxedCheck } from "../../scripts/check-agent-egress";
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

describe("claudeCodeChecks", () => {
  const checks = claudeCodeChecks({ httpsHosts: ["registry.npmjs.org"], controlPlaneHosts: ["api.anthropic.com"] });
  const find = (text: string) => checks.find((check) => check.name.includes(text))!;

  test("the process reaches only its control-plane host and its commands only the allowed hosts", () => {
    expect(find("process reaches its control-plane host api.anthropic.com")).toMatchObject({ expectFailure: false });
    expect(find("process reaches its control-plane host").argv[2]).not.toContain("CLAUDE_CODE_SHELL_PREFIX");
    expect(find("process is refused non-control host registry.npmjs.org")).toMatchObject({ expectFailure: true });
    expect(find("command reaches allowed host registry.npmjs.org").argv[2]).toStartWith("$CLAUDE_CODE_SHELL_PREFIX curl");
    expect(find("command is refused the control-plane host")).toMatchObject({ expectFailure: true });
  });

  test("checks the GitHub API and direct IP denials for commands and the credential separation", () => {
    expect(find("command: api.github.com is refused").expectFailure).toBe(true);
    expect(find("command: direct IP connection is refused").argv[2]).toContain("--noproxy '*' https://1.1.1.1");
    expect(find("process: api.github.com is refused").expectFailure).toBe(true);
    expect(find("does not receive the control-plane credential").expectFailure).toBe(false);
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
