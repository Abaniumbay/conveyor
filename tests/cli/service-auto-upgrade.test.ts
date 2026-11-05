import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { EXIT } from "../../src/cli/args";
import { renderAutoUpgradeService, renderAutoUpgradeTimer, systemd } from "../../src/cli/commands/service";
import { runCli } from "../../src/cli/main";

const original = { ...systemd };
const directories: string[] = [];
let calls: string[][] = [];

beforeEach(() => {
  calls = [];
  systemd.systemctl = async (args) => {
    calls.push(args);
    if (args[0] === "show") return { code: 0, stdout: "NextElapseUSecRealtime=Thu 2026-11-05 12:00:00 UTC\nLastTriggerUSec=Thu 2026-11-05 11:45:00 UTC", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  systemd.isRoot = () => true;
  systemd.available = () => true;
  systemd.lastOutput = async () => "already on the latest release";
});

afterEach(async () => {
  Object.assign(systemd, original);
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function machine(install = true) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-autoupgrade-"));
  directories.push(root);
  const accountHome = path.join(root, "users/conveyor");
  const home = path.join(accountHome, ".conveyor");
  await mkdir(path.join(home, "config"), { recursive: true });
  await writeFile(path.join(home, "config/conveyor.yaml"), "");
  const prefix = path.join(root, "opt/conveyor");
  await mkdir(path.join(prefix, "versions/1.0.0"), { recursive: true });
  const units = path.join(root, "systemd");
  await mkdir(units);
  systemd.unitDirectory = units;
  systemd.prefix = async () => prefix;
  const uid = process.getuid!();
  systemd.account = async (name) => (name === "conveyor" ? { name, uid, gid: uid, group: "conveyor", home: accountHome } : null);
  if (install) {
    expect((await cli("service", "install", "--account", "conveyor")).code).toBe(0);
    calls = [];
  }
  return { root, accountHome, home, prefix, units };
}

async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { out: (text) => { out.push(text); }, err: (text) => { err.push(text); }, environment: {}, interactive: false });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("conveyor service auto-upgrade install", () => {
  test("writes the oneshot service and the timer, then enables and starts the timer", async () => {
    const { home, prefix, units, accountHome } = await machine();
    const result = await cli("service", "auto-upgrade", "install");
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    const service = await readFile(path.join(units, "conveyor-auto-upgrade.service"), "utf8");
    expect(service).toBe(renderAutoUpgradeService({
      account: { name: "conveyor", uid: process.getuid!(), gid: process.getuid!(), group: "conveyor", home: accountHome },
      home,
      executable: `${prefix}/current/conveyor`,
      drainTimeout: "2h",
    }));
    expect(service).toContain("Type=oneshot\nUser=conveyor\nGroup=conveyor\n");
    expect(service).toContain(`Environment=HOME=${accountHome}\nEnvironment=CONVEYOR_HOME=${home}\nEnvironment=TMPDIR=${home}/tmp\n`);
    expect(service).toContain(`ExecStart=${prefix}/current/conveyor upgrade --latest --if-newer --no-wait --drain-timeout 2h --home ${home}\n`);
    const timer = await readFile(path.join(units, "conveyor-auto-upgrade.timer"), "utf8");
    expect(timer).toBe(renderAutoUpgradeTimer({ home, every: "15m" }));
    expect(timer).toContain("OnBootSec=5min\nOnUnitActiveSec=15m\nRandomizedDelaySec=60\nPersistent=true\n");
    expect(calls).toEqual([["daemon-reload"], ["enable", "--now", "conveyor-auto-upgrade.timer"]]);
  });

  test("--every and --drain-timeout are applied", async () => {
    const { units } = await machine();
    expect((await cli("service", "auto-upgrade", "install", "--every", "1h", "--drain-timeout", "30m")).code).toBe(0);
    expect(await readFile(path.join(units, "conveyor-auto-upgrade.timer"), "utf8")).toContain("OnUnitActiveSec=1h\n");
    expect(await readFile(path.join(units, "conveyor-auto-upgrade.service"), "utf8")).toContain("--no-wait --drain-timeout 30m --home");
  });

  test("refuses, writing nothing, when the main unit is not installed", async () => {
    const { units } = await machine(false);
    const result = await cli("service", "auto-upgrade", "install");
    expect(result.code).toBe(EXIT.failure);
    expect(result.err).toContain("conveyor is not installed");
    expect(await Bun.file(path.join(units, "conveyor-auto-upgrade.timer")).exists()).toBe(false);
    expect(await Bun.file(path.join(units, "conveyor-auto-upgrade.service")).exists()).toBe(false);
    expect(calls).toEqual([]);
  });

  test("refuses an invalid unit name", async () => {
    const { units } = await machine();
    const result = await cli("service", "auto-upgrade", "install", "--unit", "bad name;rm");
    expect(result.code).toBe(EXIT.usage);
    expect(result.err).toContain("--unit must be a systemd unit name");
    expect(calls).toEqual([]);
    expect(await Bun.file(path.join(units, "bad name;rm-auto-upgrade.timer")).exists()).toBe(false);
  });

  test("every auto-upgrade command refuses on a platform without systemd", async () => {
    await machine();
    systemd.available = () => false;
    for (const verb of ["install", "uninstall", "status"]) {
      const result = await cli("service", "auto-upgrade", verb);
      expect(result.code).toBe(EXIT.failure);
      expect(result.err).toContain("needs systemd");
    }
    expect(calls).toEqual([]);
  });
});

describe("conveyor service auto-upgrade uninstall and status", () => {
  test("uninstall stops, disables and removes both files and leaves releases", async () => {
    const { units, prefix } = await machine();
    await cli("service", "auto-upgrade", "install");
    calls = [];
    const result = await cli("service", "auto-upgrade", "uninstall");
    expect(result.code).toBe(0);
    expect(calls).toEqual([["disable", "--now", "conveyor-auto-upgrade.timer"], ["stop", "conveyor-auto-upgrade.service"], ["daemon-reload"]]);
    expect(await Bun.file(path.join(units, "conveyor-auto-upgrade.timer")).exists()).toBe(false);
    expect(await Bun.file(path.join(units, "conveyor-auto-upgrade.service")).exists()).toBe(false);
    expect((await stat(path.join(prefix, "versions/1.0.0"))).isDirectory()).toBe(true);
  });

  test("uninstall with nothing installed is a no-op with a clear line", async () => {
    await machine();
    const result = await cli("service", "auto-upgrade", "uninstall");
    expect(result.code).toBe(0);
    expect(result.out).toBe("Auto-upgrade is not installed; nothing to remove.");
    expect(calls).toEqual([]);
  });

  test("status reports installed, next and last run and the last output line; then not installed", async () => {
    await machine();
    expect((await cli("service", "auto-upgrade", "status")).out).toContain("not installed");
    await cli("service", "auto-upgrade", "install");
    const result = await cli("service", "auto-upgrade", "status");
    expect(result.out).toBe([
      "Auto-upgrade: installed, every 15m",
      "  next run: Thu 2026-11-05 12:00:00 UTC",
      "  last run: Thu 2026-11-05 11:45:00 UTC",
      "  last output: already on the latest release",
    ].join("\n"));
  });
});

describe("Auto-upgrade line in status and doctor", () => {
  test("is off without the timer and on with the interval and last check once installed", async () => {
    const { home } = await machine();
    const env = ["--home", home];
    const line = async (command: string) => (await cli(command, ...env)).out.split("\n").find((entry) => entry.includes("Auto-upgrade:"));
    expect(await line("status")).toBe("Auto-upgrade: off");
    expect(await line("doctor")).toMatch(/Auto-upgrade: off$/);
    await cli("service", "auto-upgrade", "install");
    expect(await line("status")).toBe("Auto-upgrade: on (every 15m, last checked Thu 2026-11-05 11:45:00 UTC)");
    expect(await line("doctor")).toContain("Auto-upgrade: on (every 15m, last checked Thu 2026-11-05 11:45:00 UTC)");
  });
});
