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
  return cliWithEnvironment({}, ...argv);
}

async function cliWithEnvironment(environment: NodeJS.ProcessEnv, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    out: (text) => { out.push(text); },
    err: (text) => { err.push(text); },
    environment,
    interactive: false,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

/** A stand-in for the running service's control socket; like the real one, it refuses an unforced restart while work runs. */
function controlServer(home: string, state: { active: Array<{ item: string; stage: string }>; startedAt: string; refuseRestart?: boolean }) {
  const requests: string[] = [];
  const server = Bun.serve({
    unix: path.join(home, "run/control.sock"),
    async fetch(request) {
      const route = `${request.method} ${new URL(request.url).pathname}`;
      requests.push(route);
      if (route === "GET /v1/status") return Response.json({ active: state.active, steering: 0, startedAt: state.startedAt, ready: true, version: { version: "1.0.0" } });
      if (route === "POST /v1/restart") {
        const force = ((await request.json()) as { force?: boolean }).force === true;
        if (state.refuseRestart || (state.active.length > 0 && !force)) return Response.json({ error: "work is still running: drain first, or force the restart" }, { status: 409 });
        setTimeout(() => { state.startedAt = "after-restart"; state.active = []; }, 20);
        requests.push(`restart force=${force}`);
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
  test("an environment home for another installation refuses every lifecycle command before side effects", async () => {
    const { root, home } = await machine();
    await cli("service", "install", "--account", "conveyor");
    const otherHome = path.join(root, "staging");
    await mkdir(path.join(home, "run"), { recursive: true });
    await mkdir(path.join(otherHome, "run"), { recursive: true });
    const requests = controlServer(home, { active: [], startedAt: "before" });
    calls = [];

    for (const command of [["service", "start"], ["service", "stop"], ["service", "restart"], ["service", "status"], ["service", "restart", "--drain"]]) {
      calls = [];
      requests.length = 0;
      const result = await cliWithEnvironment({ CONVEYOR_HOME: otherHome }, ...command);
      expect(result.code).toBe(EXIT.failure);
      expect(result.err).toContain(otherHome);
      expect(result.err).toContain(home);
      expect(result.err).toContain("--unit <name>");
      expect(calls).toEqual([]);
      expect(requests).toEqual([]);
    }

    const option = await cli("service", "restart", "--drain", "--home", otherHome);
    expect(option.code).toBe(EXIT.failure);
    expect(option.err).toContain(otherHome);
    expect(option.err).toContain(home);
    expect(option.err).toContain("--unit <name>");
    expect(calls).toEqual([]);
    expect(requests).toEqual([]);
  });

  test("a matching environment home proceeds with its named unit, while --home takes precedence", async () => {
    const { root, prefix, units } = await machine();
    const stagingHome = path.join(root, "staging");
    await mkdir(path.join(stagingHome, "config"), { recursive: true });
    await writeFile(path.join(stagingHome, "config/conveyor.yaml"), "");
    const installed = await cli("service", "install", "--account", "conveyor", "--unit", "conveyor-staging", "--home", stagingHome);
    expect(installed.err).toBe("");
    expect(installed.code).toBe(EXIT.ok);
    calls = [];

    const matching = await cliWithEnvironment({ CONVEYOR_HOME: stagingHome }, "service", "stop", "--unit", "conveyor-staging");
    expect(matching.code).toBe(EXIT.ok);
    expect(calls).toEqual([["stop", "conveyor-staging.service"]]);

    calls = [];
    const overridden = await cliWithEnvironment({ CONVEYOR_HOME: path.join(root, "other") }, "service", "stop", "--unit", "conveyor-staging", "--home", path.join(stagingHome, "."));
    expect(overridden.code).toBe(EXIT.ok);
    expect(calls).toEqual([["stop", "conveyor-staging.service"]]);
    expect(await readFile(path.join(units, "conveyor-staging.service"), "utf8")).toContain(`ExecStart=${prefix}/current/conveyor serve --home ${stagingHome}`);
  });

  test("an installed unit supplies the home when only a configuration override is given", async () => {
    const { home, root } = await machine();
    await cli("service", "install", "--account", "conveyor");
    await mkdir(path.join(home, "run"), { recursive: true });
    const requests = controlServer(home, { active: [], startedAt: "before" });
    calls = [];

    const shown = await cli("service", "status", "--config", path.join(root, "custom.yaml"));
    expect(shown.code).toBe(EXIT.ok);
    expect(calls[0]).toEqual(["show", "conveyor.service", "--property=ActiveState,SubState,MainPID,ExecMainStartTimestamp,UnitFileState,NRestarts"]);
    expect(requests).toEqual(["GET /v1/status"]);
  });

  test("commands keep their lifecycle behavior when no unit is installed", async () => {
    const { home } = await machine();
    await mkdir(path.join(home, "run"), { recursive: true });
    const requests = controlServer(home, { active: [], startedAt: "before" });

    const started = await cliWithEnvironment({ CONVEYOR_HOME: home }, "service", "start");
    expect(started.code).toBe(EXIT.ok);
    expect(calls).toEqual([["start", "conveyor.service"]]);
    expect(requests).toEqual(["GET /v1/status"]);

    calls = [];
    requests.length = 0;
    const stopped = await cliWithEnvironment({ CONVEYOR_HOME: home }, "service", "stop");
    expect(stopped.code).toBe(EXIT.ok);
    expect(calls).toEqual([["stop", "conveyor.service"]]);
    expect(requests).toEqual([]);

    calls = [];
    requests.length = 0;
    const restarted = await cliWithEnvironment({ CONVEYOR_HOME: home }, "service", "restart");
    expect(restarted.code).toBe(EXIT.ok);
    expect(restarted.out).toBe(`Restarted conveyor at ${home}: 1.0.0.`);
    expect(calls).toEqual([["restart", "conveyor.service"]]);
    expect(requests).toEqual(["GET /v1/status"]);

    calls = [];
    requests.length = 0;
    const status = await cliWithEnvironment({ CONVEYOR_HOME: home }, "service", "status");
    expect(status.code).toBe(EXIT.unavailable);
    expect(status.out).toBe("conveyor is not installed (conveyor service install).");
    expect(calls).toEqual([]);
    expect(requests).toEqual(["GET /v1/status"]);
  });

  test("upgrade and rollback retain an explicit home when the default unit names another home", async () => {
    const { prefix, root } = await machine();
    await cli("service", "install", "--account", "conveyor");
    const explicitHome = path.join(root, "staging");

    const upgraded = await cli("upgrade", "--home", explicitHome, "--prefix", prefix, "--archive", "release.tar.gz");
    expect(upgraded.code).toBe(EXIT.usage);
    expect(upgraded.err).toContain("--archive needs --checksums");
    expect(upgraded.err).not.toContain("does not match selected unit");

    const rolledBack = await cli("rollback", "--home", explicitHome, "--prefix", prefix);
    expect(rolledBack.code).toBe(EXIT.failure);
    expect(rolledBack.err).toContain(`${prefix}/current does not point at an installed release`);
    expect(rolledBack.err).not.toContain("does not match selected unit");
  });

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

  test("a drained stop that systemctl refuses admits work again", async () => {
    const { home } = await machine();
    await cli("service", "install", "--account", "conveyor");
    await mkdir(path.join(home, "run"), { recursive: true });
    const requests = controlServer(home, { active: [], startedAt: "before" });
    systemd.systemctl = async (args) => (args[0] === "stop" ? { code: 1, stdout: "", stderr: "Access denied" } : { code: 0, stdout: "", stderr: "" });
    const stopped = await cli("service", "stop", "--drain");
    expect(stopped.code).toBe(EXIT.failure);
    expect(stopped.err).toContain("(run it with sudo)");
    expect(requests).toEqual(["POST /v1/drain", "GET /v1/status", "DELETE /v1/drain"]);
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
    expect(restarted.out).toBe(`Restarted conveyor at ${home} after draining: 1.0.0, ready.`);
    expect(requests).toContain("POST /v1/restart");
    expect(calls).toEqual([]);
  });

  test("ordinary restart identifies the selected unit and home", async () => {
    const { home } = await machine();
    await cli("service", "install", "--account", "conveyor");
    await mkdir(path.join(home, "run"), { recursive: true });
    controlServer(home, { active: [], startedAt: "before" });
    calls = [];

    const restarted = await cli("service", "restart");
    expect(restarted.err).toBe("");
    expect(restarted.code).toBe(EXIT.ok);
    expect(restarted.out).toBe(`Restarted conveyor at ${home}: 1.0.0.`);
    expect(calls).toEqual([["restart", "conveyor.service"]]);
  });

  test("restart --drain --force interrupts work that outlived the timeout; a refused restart lifts the drain", async () => {
    const { home } = await machine();
    await cli("service", "install", "--account", "conveyor");
    systemd.isRoot = () => false;
    await mkdir(path.join(home, "run"), { recursive: true });
    const state = { active: [{ item: "app:1", stage: "implementation" }], startedAt: "before", refuseRestart: false };
    const requests = controlServer(home, state);
    const forced = await cli("service", "restart", "--drain", "--timeout", "1ms", "--force");
    expect(forced.err).toContain("Drain timed out; going ahead and interrupting: app:1 (implementation)");
    expect(forced.code).toBe(0);
    expect(requests).toContain("restart force=true");

    state.refuseRestart = true;
    requests.length = 0;
    const refused = await cli("service", "restart", "--drain");
    expect(refused.code).toBe(EXIT.rejected);
    expect(requests.slice(-2)).toEqual(["POST /v1/restart", "DELETE /v1/drain"]);
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
