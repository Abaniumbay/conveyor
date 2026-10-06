import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { EXIT } from "../../src/cli/args";
import { runCli } from "../../src/cli/main";
import { ReleaseCoordinator, SwitchRefused } from "../../src/control/releases";
import { ConveyorStore, databaseSchemaVersion, LATEST_SCHEMA_VERSION, NewerSchemaError } from "../../src/db/store";
import { ConsoleSink, log } from "../../src/log/logger";
import { currentVersion, detectPrefix, stageRelease, switchCurrent } from "../../src/release/install";
import { backupState, BACKUPS_KEPT, planRollback, readReleaseState, restoreState, RollbackRefused, writeReleaseState, type ReleaseState, type SwitchRecord } from "../../src/release/state";
import { BUILD } from "../../src/version";

const directories: string[] = [];
afterEach(async () => {
  log.configure({ sinks: [new ConsoleSink()] });
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-release-"));
  directories.push(directory);
  return directory;
}

/** A release archive whose "executable" is a shell script reporting `version` and accepting config check. */
async function fakeRelease(root: string, version: string, configCheckExit = 0): Promise<{ archive: string; checksums: string }> {
  const name = `conveyor-v${version}-linux-x64`;
  const directory = path.join(root, "build", name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "conveyor"), `#!/bin/sh\ncase "$1" in\n  --version) echo "conveyor ${version} (test)" ;;\n  config) echo "config check $*" >&2; exit ${configCheckExit} ;;\nesac\n`);
  await chmod(path.join(directory, "conveyor"), 0o755);
  await writeFile(path.join(directory, "LICENSE"), "MIT\n");
  const archive = path.join(root, `${name}.tar.gz`);
  Bun.spawnSync(["tar", "-C", path.join(root, "build"), "-czf", archive, name]);
  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  const checksums = path.join(root, `checksums-${version}.txt`);
  await writeFile(checksums, `${digest}  ${name}.tar.gz\n`);
  return { archive, checksums };
}

/** A prefix with `versions` installed and current pointing at the first. */
async function prefixWith(root: string, ...versions: string[]): Promise<string> {
  const prefix = path.join(root, "prefix");
  for (const version of versions) await stageRelease(await fakeRelease(root, version), prefix);
  await switchCurrent(prefix, versions[0]!);
  return prefix;
}

describe("installed releases", () => {
  test("stage verifies the checksum, installs into versions/<version> and keeps the running one untouched", async () => {
    const root = await temporary();
    const prefix = path.join(root, "prefix");
    const release = await fakeRelease(root, "1.0.0");
    const staged = await stageRelease(release, prefix);
    expect(staged).toMatchObject({ version: "1.0.0", executable: path.join(prefix, "versions/1.0.0/conveyor") });
    expect((await readdir(path.join(prefix, "versions"))).sort()).toEqual(["1.0.0"]);
    expect(await currentVersion(prefix)).toBeNull();

    await writeFile(release.checksums, `${"0".repeat(64)}  ${path.basename(release.archive)}\n`);
    await expect(stageRelease(release, prefix)).rejects.toThrow("checksum mismatch");
    await writeFile(release.checksums, "");
    await expect(stageRelease(release, prefix)).rejects.toThrow("checksums.txt has no entry");
  });

  test("switch points current at an installed version atomically; the prefix is detected from the executable", async () => {
    const root = await temporary();
    const prefix = await prefixWith(root, "1.0.0", "1.1.0");
    expect(await currentVersion(prefix)).toBe("1.0.0");
    await switchCurrent(prefix, "1.1.0");
    expect(await readlink(path.join(prefix, "current"))).toBe("versions/1.1.0");
    expect((await lstat(path.join(prefix, "current"))).isSymbolicLink()).toBe(true);
    await expect(switchCurrent(prefix, "2.0.0")).rejects.toThrow("version 2.0.0 is not installed");
    await symlink(path.join(prefix, "current/conveyor"), path.join(root, "conveyor"));
    expect(await detectPrefix(path.join(root, "conveyor"))).toBe(prefix);
    expect(await detectPrefix(process.execPath)).toBeNull();
  });
});

describe("state backups and schema", () => {
  test("a backup is a consistent copy taken while the database is open; restore replaces it; old backups are pruned", async () => {
    const home = await temporary();
    const database = path.join(home, "state/conveyor.sqlite");
    const store = await ConveyorStore.open(database);
    store.seedDashboardSuperuser("admin", "hash-before");
    await writeFile(path.join(home, "state/session-secret"), "secret-before\n");
    const backup = await backupState({ home, database, label: "a-to-b", open: store.sqlite() });
    store.changeDashboardPassword(store.dashboardAccounts()[0]!.id, "hash-after");
    store.close();
    await writeFile(path.join(home, "state/session-secret"), "secret-after\n");

    await restoreState(backup, database);
    const restored = await ConveyorStore.open(database);
    expect(restored.dashboardAccounts()[0]!.passwordHash).toBe("hash-before");
    restored.close();
    expect(await readFile(path.join(home, "state/session-secret"), "utf8")).toBe("secret-before\n");

    for (let index = 0; index < BACKUPS_KEPT + 2; index += 1) await backupState({ home, database, label: `n${index}` });
    expect(await readdir(path.join(home, "backups"))).toHaveLength(BACKUPS_KEPT);
  });

  test("run as root, restored, backed-up and bookkeeping files get the owner of what they replace or of the home", async () => {
    const home = await temporary();
    const database = path.join(home, "state/conveyor.sqlite");
    (await ConveyorStore.open(database)).close();
    const backup = await backupState({ home, database, label: "x" });
    const chown = spyOn(fsPromises, "chown").mockResolvedValue(undefined);
    const getuid = spyOn(process, "getuid").mockReturnValue(0);
    try {
      await restoreState(backup, database);
      await writeReleaseState(home, { pending: null, history: [] });
      await backupState({ home, database, label: "y" });
      const owner = await stat(home);
      const targets = chown.mock.calls.map(([target, uid, gid]) => ({ target: String(target), uid, gid }));
      expect(targets.some((call) => call.target === `${database}.restore`)).toBe(true);
      expect(targets.some((call) => call.target.endsWith(".tmp"))).toBe(true);
      expect(targets.some((call) => call.target.endsWith("-y"))).toBe(true);
      expect(targets.every((call) => call.uid === owner.uid && call.gid === owner.gid)).toBe(true);
    } finally {
      getuid.mockRestore();
      chown.mockRestore();
    }
    // Not root: nothing is chowned.
    const untouched = spyOn(fsPromises, "chown");
    await restoreState(backup, database);
    expect(untouched).not.toHaveBeenCalled();
    untouched.mockRestore();
  });

  test("an older Conveyor refuses a database migrated by a newer one", async () => {
    const home = await temporary();
    const database = path.join(home, "conveyor.sqlite");
    (await ConveyorStore.open(database)).close();
    expect(databaseSchemaVersion(database)).toBe(LATEST_SCHEMA_VERSION);
    const raw = new Database(database);
    raw.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(LATEST_SCHEMA_VERSION + 1, new Date().toISOString());
    raw.close();
    await expect(ConveyorStore.open(database)).rejects.toBeInstanceOf(NewerSchemaError);
    await expect(ConveyorStore.open(database)).rejects.toThrow("conveyor rollback --restore-backup");
  });

  test("rollback goes back to the version the last upgrade replaced, and needs the backup when the schema grew", () => {
    const record: SwitchRecord = { id: "u1", kind: "upgrade", from: "1.0.0", to: "1.1.0", fromSchema: 14, toSchema: 15, backup: "/b/1", status: "completed", reason: null, requestedAt: "2026-10-06T10:00:00Z", finishedAt: null };
    const state: ReleaseState = { pending: null, history: [record] };
    expect(planRollback(state, "1.1.0", 14, false)).toMatchObject({ target: "1.0.0", restoreBackup: null });
    expect(() => planRollback(state, "1.1.0", 15, false)).toThrow(RollbackRefused);
    expect(() => planRollback(state, "1.1.0", 15, false)).toThrow("schema 14 -> 15");
    expect(planRollback(state, "1.1.0", 15, true)).toMatchObject({ target: "1.0.0", restoreBackup: "/b/1" });
    expect(() => planRollback(state, "1.2.0", 15, true)).toThrow("no upgrade to 1.2.0 is recorded");
    expect(() => planRollback({ pending: null, history: [{ ...record, backup: null }] }, "1.1.0", 15, true)).toThrow("kept no backup");
    // After rolling back to 1.0.0, a second rollback does not "return" forward to 1.1.0.
    const rolledBack: ReleaseState = { pending: null, history: [record, { ...record, id: "r1", kind: "rollback", from: "1.1.0", to: "1.0.0" }] };
    expect(() => planRollback(rolledBack, "1.0.0", 14, false)).toThrow("no upgrade to 1.0.0 is recorded");
  });
});

/** A coordinator over a real store with controllable activity and recorded stops. */
async function coordinator(options: { supervised?: boolean; versions?: string[] } = {}) {
  const root = await temporary();
  log.configure({ sinks: [] });
  const home = path.join(root, "home");
  const store = await ConveyorStore.open(path.join(home, "state/conveyor.sqlite"));
  const prefix = await prefixWith(root, ...(options.versions ?? [BUILD.version, "9.9.9"]));
  const activity = { items: [] as Array<{ issueId: string; repositoryId: string; stageId: string }>, steering: 0 };
  const calls: string[] = [];
  const service = {
    store,
    drain: (reason: string) => { calls.push(`drain:${reason}`); return { since: "now", reason }; },
    resumeAdmission: () => { calls.push("resume"); return true; },
    activeWork: () => activity,
  };
  const stops: Array<{ reason: string; code: number; afterClose?: () => Promise<void> }> = [];
  const releases = new ReleaseCoordinator(service as never, home, {
    supervised: options.supervised ?? true,
    restartExitCode: 75,
    stop: (reason, code, afterClose) => stops.push({ reason, code, ...(afterClose ? { afterClose } : {}) }),
  }, 10);
  directories.push(root);
  return { home, prefix, store, activity, calls, stops, releases, close: () => store.close() };
}

describe("switching the running service", () => {
  test("an upgrade drains, waits for running work, backs up, switches and exits for a restart", async () => {
    const world = await coordinator();
    // The stage that requested the upgrade (Conveyor delivering itself) is still running.
    world.activity.items.push({ issueId: "conveyor-90", repositoryId: "conveyor", stageId: "deploy" });
    const pending = await world.releases.schedule({ kind: "upgrade", version: "9.9.9", prefix: world.prefix, drainTimeoutMs: 60_000 });
    expect(world.calls).toEqual(["drain:upgrade to 9.9.9"]);
    expect((await readReleaseState(world.home)).pending).toMatchObject({ id: pending.id, version: "9.9.9", from: BUILD.version });
    await world.releases.tick();
    expect(world.stops).toEqual([]);
    expect(await currentVersion(world.prefix)).toBe(BUILD.version);

    // Its stage finished (the boundary is recorded by the engine); nothing else runs.
    world.activity.items.length = 0;
    await world.releases.tick();
    expect(world.stops).toMatchObject([{ reason: "upgrade to 9.9.9", code: 75 }]);
    expect(await currentVersion(world.prefix)).toBe("9.9.9");
    const state = await readReleaseState(world.home);
    expect(state.pending).toBeNull();
    expect(state.history).toMatchObject([{ id: pending.id, kind: "upgrade", from: BUILD.version, to: "9.9.9", status: "switched", fromSchema: LATEST_SCHEMA_VERSION }]);
    expect(await readdir(state.history[0]!.backup!)).toContain("conveyor.sqlite");
    world.close();
  });

  test("a drain that times out cancels the switch and admits work again", async () => {
    const world = await coordinator();
    world.activity.items.push({ issueId: "i", repositoryId: "app", stageId: "implementation" });
    await world.releases.schedule({ kind: "upgrade", version: "9.9.9", prefix: world.prefix, drainTimeoutMs: 1 });
    await Bun.sleep(5);
    await world.releases.tick();
    expect(world.calls).toEqual(["drain:upgrade to 9.9.9", "resume"]);
    expect(world.stops).toEqual([]);
    const state = await readReleaseState(world.home);
    expect(state.pending).toBeNull();
    expect(state.history[0]).toMatchObject({ status: "cancelled", reason: expect.stringContaining("the drain timed out with work still running (app/implementation)") });
    world.close();
  });

  test("a switch that fails keeps the running release and admits work again", async () => {
    const world = await coordinator();
    await world.releases.schedule({ kind: "upgrade", version: "9.9.9", prefix: world.prefix, drainTimeoutMs: 60_000 });
    await rm(path.join(world.prefix, "versions/9.9.9"), { recursive: true });
    await world.releases.tick();
    expect(world.stops).toEqual([]);
    expect(world.calls.at(-1)).toBe("resume");
    expect((await readReleaseState(world.home)).history[0]).toMatchObject({ status: "failed", reason: expect.stringContaining("not installed") });
    world.close();
  });

  test("refuses when nothing would restart the process, when one is pending, or for an absent version", async () => {
    const unsupervised = await coordinator({ supervised: false });
    await expect(unsupervised.releases.schedule({ kind: "upgrade", version: "9.9.9", prefix: unsupervised.prefix, drainTimeoutMs: 1_000 })).rejects.toThrow("not run by systemd");
    unsupervised.close();
    const world = await coordinator({ versions: [BUILD.version, "9.9.9", "0.0.1"] });
    await expect(world.releases.schedule({ kind: "upgrade", version: "8.0.0", prefix: world.prefix, drainTimeoutMs: 1_000 })).rejects.toBeInstanceOf(SwitchRefused);
    await expect(world.releases.schedule({ kind: "upgrade", version: "0.0.1", prefix: world.prefix, drainTimeoutMs: 1_000 })).rejects.toThrow("older than the running");
    await world.releases.schedule({ kind: "upgrade", version: "9.9.9", prefix: world.prefix, drainTimeoutMs: 60_000 });
    await expect(world.releases.schedule({ kind: "upgrade", version: "9.9.9", prefix: world.prefix, drainTimeoutMs: 1_000 })).rejects.toThrow("already pending");
    world.close();
  });

  test("the release that starts records the outcome; a stale pending switch is cancelled", async () => {
    const world = await coordinator();
    const base: SwitchRecord = { id: "s1", kind: "upgrade", from: "0.0.1", to: BUILD.version, fromSchema: 1, toSchema: null, backup: null, status: "switched", reason: null, requestedAt: "t", finishedAt: null };
    await writeReleaseState(world.home, { pending: { id: "p1", kind: "upgrade", version: "9.9.9", from: BUILD.version, prefix: world.prefix, restoreBackup: null, requestedAt: "t", drainDeadline: "t" }, history: [base] });
    await world.releases.onStartup();
    const state = await readReleaseState(world.home);
    expect(state.pending).toBeNull();
    expect(state.history.find((record) => record.id === "s1")).toMatchObject({ status: "completed", toSchema: LATEST_SCHEMA_VERSION });
    expect(state.history.find((record) => record.id === "p1")).toMatchObject({ status: "cancelled", reason: "the service restarted before the switch" });

    await writeReleaseState(world.home, { pending: null, history: [{ ...base, id: "s2", to: "9.9.9" }] });
    await world.releases.onStartup();
    expect((await readReleaseState(world.home)).history[0]).toMatchObject({ status: "failed", reason: `expected 9.9.9 to start, but ${BUILD.version} started` });
    world.close();
  });

  test("a rollback after a migration needs the backup, restores it once the database is closed, then switches", async () => {
    const world = await coordinator({ versions: ["1.0.0", BUILD.version] });
    await switchCurrent(world.prefix, BUILD.version);
    const backup = await backupState({ home: world.home, database: world.store.sqlite().filename, label: "1.0.0-to-now", open: world.store.sqlite() });
    await writeReleaseState(world.home, { pending: null, history: [{ id: "u", kind: "upgrade", from: "1.0.0", to: BUILD.version, fromSchema: LATEST_SCHEMA_VERSION - 1, toSchema: LATEST_SCHEMA_VERSION, backup, status: "completed", reason: null, requestedAt: "t", finishedAt: "t" }] });
    await expect(world.releases.schedule({ kind: "rollback", prefix: world.prefix, drainTimeoutMs: 60_000 })).rejects.toThrow("--restore-backup");
    const pending = await world.releases.schedule({ kind: "rollback", prefix: world.prefix, restoreBackup: true, drainTimeoutMs: 60_000 });
    expect(pending).toMatchObject({ version: "1.0.0", restoreBackup: backup });
    await world.releases.tick();
    expect(world.stops).toHaveLength(1);
    // Nothing switches before the database is closed.
    expect(await currentVersion(world.prefix)).toBe(BUILD.version);
    world.store.seedDashboardSuperuser("created-after-backup", "h");
    world.close();
    await world.stops[0]!.afterClose!();
    expect(await currentVersion(world.prefix)).toBe("1.0.0");
    const restored = await ConveyorStore.open(world.store.sqlite().filename).catch(() => null);
    expect(restored?.dashboardAccounts().map((account) => account.username)).toEqual([]);
    restored?.close();
  });
});

describe("conveyor upgrade and rollback with the service stopped", () => {
  async function cli(home: string, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli([...argv, "--home", home], { out: (text) => out.push(text), err: (text) => err.push(text), environment: {}, interactive: false });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  test("upgrade verifies, validates the configuration with the new release, backs up and switches; rollback returns", async () => {
    const root = await temporary();
    const prefix = await prefixWith(root, "1.0.0");
    const home = path.join(root, "home");
    await writeFile(path.join(root, "password"), "correct horse battery\n");
    expect((await cli(home, "init", "--admin-username", "admin", "--admin-password-file", path.join(root, "password"))).code).toBe(0);

    const refused = await fakeRelease(root, "1.2.0", 3);
    const invalid = await cli(home, "upgrade", "--prefix", prefix, "--archive", refused.archive, "--checksums", refused.checksums);
    expect(invalid.code).toBe(EXIT.config);
    expect(invalid.err).toContain("does not validate with 1.2.0; nothing was switched");
    expect(await currentVersion(prefix)).toBe("1.0.0");

    const release = await fakeRelease(root, "1.1.0");
    const upgraded = await cli(home, "upgrade", "--prefix", prefix, "--archive", release.archive, "--checksums", release.checksums);
    expect(upgraded.err).toContain("Verified and installed 1.1.0");
    expect(upgraded.code).toBe(0);
    expect(upgraded.out).toContain("from 1.0.0 to 1.1.0; backup:");
    expect(await currentVersion(prefix)).toBe("1.1.0");
    const history = (await readReleaseState(home)).history;
    expect(history).toMatchObject([{ kind: "upgrade", from: "1.0.0", to: "1.1.0", status: "switched", fromSchema: LATEST_SCHEMA_VERSION }]);

    // The service would mark it completed when 1.1.0 starts; here the schema did not change.
    history[0]!.status = "completed";
    await writeReleaseState(home, { pending: null, history });
    const rolledBack = await cli(home, "rollback", "--prefix", prefix);
    expect(rolledBack.code).toBe(0);
    expect(await currentVersion(prefix)).toBe("1.0.0");
  });

  test("upgrade refuses a release older than the current one and points at rollback", async () => {
    const root = await temporary();
    const prefix = await prefixWith(root, "1.2.0");
    const home = path.join(root, "home");
    await mkdir(path.join(home, "config"), { recursive: true });
    const older = await fakeRelease(root, "1.1.0");
    const refused = await cli(home, "upgrade", "--prefix", prefix, "--archive", older.archive, "--checksums", older.checksums);
    expect(refused.code).toBe(EXIT.rejected);
    expect(refused.err).toContain("1.1.0 is older than 1.2.0: upgrade only moves forward");
    expect(await currentVersion(prefix)).toBe("1.2.0");
    const same = await fakeRelease(path.join(root, "again"), "1.2.0");
    expect((await cli(home, "upgrade", "--prefix", prefix, "--archive", same.archive, "--checksums", same.checksums)).out).toBe("1.2.0 is already current.");
  });

  test("rollback refuses after a migration without --restore-backup (exit 5) and restores with it", async () => {
    const root = await temporary();
    const prefix = await prefixWith(root, "1.0.0", "1.1.0");
    await switchCurrent(prefix, "1.1.0");
    const home = path.join(root, "home");
    const database = path.join(home, "state/conveyor.sqlite");
    const store = await ConveyorStore.open(database);
    const backup = await backupState({ home, database, label: "x", open: store.sqlite() });
    store.seedDashboardSuperuser("later", "h");
    store.close();
    await writeReleaseState(home, { pending: null, history: [{ id: "u", kind: "upgrade", from: "1.0.0", to: "1.1.0", fromSchema: LATEST_SCHEMA_VERSION - 1, toSchema: LATEST_SCHEMA_VERSION, backup, status: "completed", reason: null, requestedAt: "t", finishedAt: "t" }] });
    await mkdir(path.join(home, "config"), { recursive: true });
    await writeFile(path.join(home, "config/conveyor.yaml"), "providers: !include builtin:providers.yaml\n");

    // A configuration that does not load stops it: the database path is never guessed.
    await rename(path.join(home, "config/conveyor.yaml"), path.join(home, "config/conveyor.yaml.off"));
    expect((await cli(home, "rollback", "--prefix", prefix, "--restore-backup")).code).toBe(EXIT.config);
    await rename(path.join(home, "config/conveyor.yaml.off"), path.join(home, "config/conveyor.yaml"));

    // The target release must be installed before the database is touched.
    await rename(path.join(prefix, "versions/1.0.0"), path.join(prefix, "versions/1.0.0.moved"));
    const missing = await cli(home, "rollback", "--prefix", prefix, "--restore-backup");
    expect(missing.code).toBe(EXIT.failure);
    expect(missing.err).toContain("version 1.0.0 is not installed");
    expect(missing.err).toContain("nothing was changed");
    await rename(path.join(prefix, "versions/1.0.0.moved"), path.join(prefix, "versions/1.0.0"));
    const untouched = await ConveyorStore.open(database);
    expect(untouched.dashboardAccounts().map((account) => account.username)).toEqual(["later"]);
    untouched.close();
    expect(await currentVersion(prefix)).toBe("1.1.0");

    const refused = await cli(home, "rollback", "--prefix", prefix);
    expect(refused.code).toBe(EXIT.rejected);
    expect(refused.err).toContain("--restore-backup");
    expect(await currentVersion(prefix)).toBe("1.1.0");

    const restored = await cli(home, "rollback", "--prefix", prefix, "--restore-backup");
    expect(restored.code).toBe(0);
    expect(await currentVersion(prefix)).toBe("1.0.0");
    const reopened = await ConveyorStore.open(database);
    expect(reopened.dashboardAccounts()).toEqual([]);
    reopened.close();
  });
});
