import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { EXIT } from "../../src/cli/args";
import { renderUnit, systemd } from "../../src/cli/commands/service";
import { runCli } from "../../src/cli/main";

const original = { ...systemd };
const directories: string[] = [];
let calls: string[][] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];

beforeEach(() => {
  calls = [];
  systemd.systemctl = async (args) => {
    calls.push(args);
    if (args[0] === "show") return { code: 0, stdout: "ActiveState=active\nSubState=running\nMainPID=4242\nExecMainStartTimestamp=Mon 2026-10-06 10:00:00 UTC\nUnitFileState=enabled\nNRestarts=1", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  systemd.isRoot = () => true;
});

afterEach(async () => {
  Object.assign(systemd, original);
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** An account owned home with a configuration, a prefix and a unit directory. */
async function machine() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-service-"));
  directories.push(root);
  const accountHome = path.join(root, "users/conveyor");
  const home = path.join(accountHome, ".conveyor");
  await mkdir(path.join(home, "config"), { recursive: true });
  await writeFile(path.join(home, "config/conveyor.yaml"), "");
  const prefix = path.join(root, "opt/conveyor");
  await mkdir(prefix, { recursive: true });
  const units = path.join(root, "systemd");
  await mkdir(units);
  systemd.unitDirectory = units;
  systemd.prefix = async () => prefix;
  const uid = process.getuid!();
  systemd.account = async (name) => (name === "conveyor" ? { name, uid, gid: uid, group: "conveyor", home: accountHome } : name === "root" ? { name, uid: 0, gid: 0, group: "root", home: "/root" } : null);
  return { root, accountHome, home, prefix, units };
}

async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { out: (text) => out.push(text), err: (text) => err.push(text), environment: {}, interactive: false });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** A stand-in for the running service's control socket. */
function controlServer(home: string, state: { active: Array<{ item: string; stage: string }>; startedAt: string }) {
  const requests: string[] = [];
  const server = Bun.serve({
    unix: path.join(home, "run/control.sock"),
    fetch(request) {
      const route = `${request.method} ${new URL(request.url).pathname}`;
      requests.push(route);
      if (route === "GET /v1/status") return Response.json({ active: state.active, steering: 0, startedAt: state.startedAt, ready: true, version: { version: "1.0.0" } });
      if (route === "POST /v1/restart") {
        setTimeout(() => { state.startedAt = "after-restart"; }, 20);
        return Response.json({ restarting: true });
      }
      return Response.json({});
    },
  });
  servers.push(server);
  return requests;
}

describe("conveyor service install", () => {
  test("writes a unit with the account, home, configuration and stable executable, then enables it", async () => {
    const { home, prefix, units, accountHome } = await machine();
    const result = await cli("service", "install", "--account", "conveyor");
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    const unit = await readFile(path.join(units, "conveyor.service"), "utf8");
    expect(unit).toContain("User=conveyor\nGroup=conveyor\n");
    expect(unit).toContain(`Environment=HOME=${accountHome}\n`);
    expect(unit).toContain(`Environment=CONVEYOR_HOME=${home}\n`);
    expect(unit).toContain(`WorkingDirectory=${home}\n`);
    expect(unit).toContain(`ExecStart=${prefix}/current/conveyor serve --home ${home} --config ${home}/config/conveyor.yaml\n`);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain(`Environment=PATH=${accountHome}/.local/bin:${accountHome}/.bun/bin:`);
    expect((await stat(path.join(units, "conveyor.service"))).mode & 0o777).toBe(0o644);
    expect(calls).toEqual([["daemon-reload"], ["enable", "conveyor.service"]]);
  });

  test("needs root, a non-root account, an initialised home and account-owned paths", async () => {
    const { home } = await machine();
    systemd.isRoot = () => false;
    expect((await cli("service", "install", "--account", "conveyor")).err).toContain("run it with sudo");
    systemd.isRoot = () => true;
    expect((await cli("service", "install", "--account", "root")).err).toContain("must not run as root");
    expect((await cli("service", "install")).code).toBe(EXIT.usage);
    await rm(home, { recursive: true });
    const missing = await cli("service", "install", "--account", "conveyor");
    expect(missing.code).toBe(EXIT.failure);
    expect(missing.err).toContain("does not exist: run conveyor init as conveyor first");
    expect(calls).toEqual([]);
  });

  test("a home owned by another account is refused with the fix", async () => {
    await machine();
    const owner = systemd.account;
    systemd.account = async (name) => {
      const account = await owner(name);
      return account && { ...account, uid: account.uid + 1 };
    };
    const result = await cli("service", "install", "--account", "conveyor");
    expect(result.err).toContain("must belong to conveyor: sudo chown -R conveyor:");
  });

  test("quotes ExecStart arguments that systemd would split", () => {
    const unit = renderUnit({ account: { name: "c", uid: 1, gid: 1, group: "c", home: "/home/c" }, home: "/srv/my conveyor", config: "/srv/my conveyor/config/conveyor.yaml", executable: "/opt/conveyor/current/conveyor", path: "/usr/bin" });
    expect(unit).toContain('ExecStart=/opt/conveyor/current/conveyor serve --home "/srv/my conveyor" --config "/srv/my conveyor/config/conveyor.yaml"');
  });
});

describe("service lifecycle", () => {
  test("commands find the home in the installed unit; stop --drain waits for idle before stopping", async () => {
    const { home } = await machine();
    await cli("service", "install", "--account", "conveyor");
    calls = [];
    await mkdir(path.join(home, "run"), { recursive: true });
    const state = { active: [] as Array<{ item: string; stage: string }>, startedAt: "before" };
    const requests = controlServer(home, state);
    const stopped = await cli("service", "stop", "--drain");
    expect(stopped.code).toBe(0);
    expect(requests.slice(0, 2)).toEqual(["POST /v1/drain", "GET /v1/status"]);
    expect(calls).toEqual([["stop", "conveyor.service"]]);
  });

  test("a drain that times out admits work again and stops nothing, unless forced", async () => {
    const { home } = await machine();
    await cli("service", "install", "--account", "conveyor");
    calls = [];
    await mkdir(path.join(home, "run"), { recursive: true });
    const requests = controlServer(home, { active: [{ item: "app:1", stage: "implementation" }], startedAt: "before" });
    const refused = await cli("service", "stop", "--drain", "--timeout", "1ms");
    expect(refused.code).toBe(EXIT.failure);
    expect(refused.err).toContain("work is still running after 1ms: app:1 (implementation)");
    expect(requests).toContain("DELETE /v1/drain");
    expect(calls).toEqual([]);
    const forced = await cli("service", "stop", "--drain", "--timeout", "1ms", "--force");
    expect(forced.code).toBe(0);
    expect(calls).toEqual([["stop", "conveyor.service"]]);
  });

  test("restart --drain asks the service to exit once idle and waits for the new process, without systemctl", async () => {
    const { home } = await machine();
    await cli("service", "install", "--account", "conveyor");
    calls = [];
    systemd.isRoot = () => false;
    await mkdir(path.join(home, "run"), { recursive: true });
    const requests = controlServer(home, { active: [], startedAt: "before" });
    const restarted = await cli("service", "restart", "--drain");
    expect(restarted.err).toBe("");
    expect(restarted.out).toBe("Restarted conveyor after draining: 1.0.0, ready.");
    expect(requests).toContain("POST /v1/restart");
    expect(calls).toEqual([]);
  });

  test("status reports the unit and the running service; uninstall removes only the unit", async () => {
    const { home, units } = await machine();
    await cli("service", "install", "--account", "conveyor");
    await mkdir(path.join(home, "run"), { recursive: true });
    controlServer(home, { active: [], startedAt: "before" });
    const shown = await cli("service", "status");
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("conveyor: active (running), enabled, pid 4242");
    expect(shown.out).toContain(`runs as conveyor; home ${home}`);
    expect(shown.out).toContain("serving 1.0.0, ready");
    calls = [];
    const removed = await cli("service", "uninstall");
    expect(removed.code).toBe(0);
    expect(calls).toEqual([["disable", "--now", "conveyor.service"], ["daemon-reload"]]);
    expect(await stat(path.join(units, "conveyor.service")).catch(() => null)).toBeNull();
    expect((await stat(home)).isDirectory()).toBe(true);
    expect(removed.out).toContain(`configuration, credentials and state: ${home}`);
  });
});
