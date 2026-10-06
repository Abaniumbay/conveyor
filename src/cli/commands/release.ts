// conveyor upgrade / rollback: explicit, verified switches between installed releases. With the
// service running, the service itself drains, backs up, switches and restarts (see
// src/control/releases.ts) and this command waits for the new release to report ready; with it
// stopped, this command backs up and switches directly.

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";

import { databaseSchemaVersion } from "../../db/store";
import {
  currentVersion, DEFAULT_REPOSITORY, detectPrefix, downloadRelease, releaseTag, ReleaseError, requireInstalled, stageRelease, switchCurrent,
} from "../../release/install";
import {
  backupState, planRollback, readReleaseState, restoreState, RollbackRefused, updateRecord, writeReleaseState, type PendingSwitch, type SwitchRecord,
} from "../../release/state";
import { compareVersions } from "../../release/semver";
import { CliError, EXIT, parseDuration } from "../args";
import { loadCommandConfig, printJson, stringOption, type Command, type CommandContext } from "../command";
import { control, ServiceUnavailable } from "../control-client";
import { runningServe } from "../process-lock";
import { installedUnit, systemd, withUnitHome } from "./service";

const SWITCH_OPTIONS = {
  prefix: { type: "string", value: "<dir>", description: "the install prefix (default: the one this conveyor runs from)" },
  "drain-timeout": { type: "string", value: "<duration>", description: "how long running work may take to finish before the switch is cancelled (default 30m)" },
  "wait-timeout": { type: "string", value: "<duration>", description: "how long to wait for the new release to report ready after the drain (default 5m)" },
  "no-wait": { type: "boolean", description: "return once the service accepted the switch (for a deploy stage upgrading Conveyor itself)" },
} as const;

async function prefixFor(context: CommandContext): Promise<string> {
  const given = stringOption(context, "prefix");
  const prefix = given ?? (await detectPrefix());
  if (!prefix) throw new CliError("this conveyor does not run from an installed release (<prefix>/versions/<version>/conveyor): pass --prefix", EXIT.usage);
  return prefix;
}

function timeout(context: CommandContext, option: string, fallback: string): number {
  return parseDuration(stringOption(context, option) ?? fallback, `--${option}`);
}

/** The configured database. A configuration that does not load stops the command: guessing a path could back up or restore the wrong file. */
async function databasePath(context: CommandContext): Promise<string> {
  return (await loadCommandConfig(context, null)).settings.database;
}

interface ServiceStatus { version: { version: string }; ready: boolean; startedAt: string }

/**
 * The running service's status, or null only when no Conveyor process runs for this home. A process
 * that is starting (or not answering) is not "stopped": acting directly under it would corrupt state.
 */
async function serviceStatus(context: CommandContext): Promise<ServiceStatus | null> {
  const status = await control<ServiceStatus>(context, "GET", "/v1/status").catch((error: unknown) => {
    if (error instanceof ServiceUnavailable) return null;
    throw error;
  });
  if (status) return status;
  const pid = await runningServe(context.paths.run);
  const unit = await installedUnit();
  const active = unit && unit.home === context.paths.home && (await systemd.systemctl(["is-active", "--quiet", "conveyor.service"])).code === 0;
  if (pid || active) {
    throw new CliError(`Conveyor is running for this home${pid ? ` (pid ${pid})` : ""} but not answering on its control socket yet; wait for it to start, or stop it (conveyor service stop), then retry`, EXIT.rejected);
  }
  return null;
}

/** Waits until the switch with `id` is recorded and its release reports ready; throws with the recorded reason otherwise. */
async function waitForSwitch(context: CommandContext, pending: PendingSwitch, timeoutMs: number): Promise<SwitchRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await readReleaseState(context.paths.home);
    const record = state.history.find((entry) => entry.id === pending.id);
    if (record && (record.status === "cancelled" || record.status === "failed")) {
      throw new CliError(`the ${pending.kind} to ${pending.version} was ${record.status}: ${record.reason ?? "no reason recorded"}`, EXIT.failure);
    }
    const service = await serviceStatus(context).catch(() => null);
    if (record?.status === "completed" && service?.version.version === pending.version && service.ready) return record;
    if (Date.now() > deadline) {
      const where = record ? `the service has not reported ${pending.version} ready` : "the service has not switched yet";
      throw new CliError(`timed out: ${where}. Check conveyor status and conveyor logs; conveyor rollback returns to ${pending.from}.`, EXIT.failure);
    }
    await Bun.sleep(1_000);
  }
}

async function latestTag(): Promise<string> {
  const repository = process.env.CONVEYOR_REPOSITORY ?? DEFAULT_REPOSITORY;
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, { headers: { accept: "application/vnd.github+json" } });
  if (!response.ok) throw new CliError(`cannot find the latest release of ${repository} (HTTP ${response.status}); pass --version`, EXIT.failure);
  return ((await response.json()) as { tag_name: string }).tag_name;
}

/**
 * Records the switch, then performs it (the link moves last). If performing it fails, the record is
 * marked failed, so the history never claims a switch the link does not show, or the reverse.
 */
async function recordThenSwitch(
  context: CommandContext,
  entry: Pick<SwitchRecord, "kind" | "from" | "to" | "fromSchema" | "backup">,
  perform: () => Promise<void>,
): Promise<void> {
  const id = randomUUID();
  const state = await readReleaseState(context.paths.home);
  state.history.push({ id, ...entry, toSchema: null, status: "switched", reason: null, requestedAt: new Date().toISOString(), finishedAt: null });
  await writeReleaseState(context.paths.home, state);
  try {
    await perform();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await updateRecord(context.paths.home, id, { status: "failed", reason, finishedAt: new Date().toISOString() }).catch(() => {});
    throw new CliError(`the ${entry.kind} to ${entry.to} failed: ${reason}`, EXIT.failure);
  }
}

export const upgrade: Command = {
  name: "upgrade",
  summary: "download, verify and switch to another release, draining running work first",
  options: {
    version: { type: "string", value: "<vX.Y.Z>", description: "the release to install (default: the latest)" },
    archive: { type: "string", value: "<file>", description: "install this release archive instead of downloading it (needs --checksums)" },
    checksums: { type: "string", value: "<file>", description: "the release's checksums.txt, for --archive" },
    ...SWITCH_OPTIONS,
  },
  details: [
    "Steps: verify the archive's checksum, install it beside the current release, validate the",
    "configuration with it, then (service running) stop admitting work, wait for running work, back",
    "up the database, switch and restart, and wait until the new release reports ready. Configuration",
    "and data are never changed by an upgrade apart from the new release's database migrations.",
  ].join("\n"),
  async run(rawContext) {
    const context = await withUnitHome(rawContext);
    const prefix = await prefixFor(context);
    const archive = stringOption(context, "archive");
    const checksums = stringOption(context, "checksums");
    if (archive && !checksums) throw new CliError("--archive needs --checksums", EXIT.usage);
    const drainTimeoutMs = timeout(context, "drain-timeout", "30m");
    const waitTimeoutMs = timeout(context, "wait-timeout", "5m");

    const downloaded = archive ? null : await downloadRelease(releaseTag(stringOption(context, "version") ?? await latestTag()));
    let staged;
    try {
      staged = await stageRelease(archive ? { archive, checksums: checksums! } : downloaded!, prefix);
    } catch (error) {
      if (error instanceof ReleaseError) throw new CliError(error.message, EXIT.failure);
      throw error;
    } finally {
      await downloaded?.cleanup();
    }
    context.err(`Verified and installed ${staged.version} in ${prefix}/versions/${staged.version} (sha256 ${staged.sha256.slice(0, 16)}...)`);

    // The new release must accept the configuration before anything switches.
    const check = Bun.spawn([staged.executable, "config", "check", "--home", context.paths.home, "--config", context.paths.config], { stdout: "ignore", stderr: "pipe" });
    const [checkErrors, checkCode] = await Promise.all([new Response(check.stderr).text(), check.exited]);
    if (checkCode !== 0) throw new CliError(`the configuration does not validate with ${staged.version}; nothing was switched:\n${checkErrors.trim()}`, EXIT.config);

    const service = await serviceStatus(context);
    const current = service?.version.version ?? (await currentVersion(prefix));
    if (current && compareVersions(staged.version, current) <= 0) {
      if (staged.version === current) return context.out(`${staged.version} is already ${service ? "running" : "current"}.`);
      // An older release may not run on a database the current one migrated: going back is a rollback.
      throw new CliError(`${staged.version} is older than ${current}: upgrade only moves forward. To return to an earlier release, use conveyor rollback.`, EXIT.rejected);
    }
    if (service) {
      const { pending } = await control<{ pending: PendingSwitch }>(context, "POST", "/v1/releases", { kind: "upgrade", version: staged.version, prefix, drainTimeoutMs });
      if (context.options["no-wait"]) {
        if (context.json) return printJson(context, { scheduled: pending });
        return context.out(`Scheduled the upgrade from ${pending.from} to ${pending.version}: the service switches once running work finishes (by ${pending.drainDeadline}).`);
      }
      context.err(`Draining: the service switches to ${pending.version} once running work finishes (by ${pending.drainDeadline})...`);
      const record = await waitForSwitch(context, pending, drainTimeoutMs + waitTimeoutMs);
      if (context.json) return printJson(context, record);
      return context.out(`Upgraded from ${record.from} to ${record.to}; it is running and ready. Backup: ${record.backup}${record.toSchema !== record.fromSchema ? ` (database schema ${record.fromSchema} -> ${record.toSchema})` : ""}`);
    }

    // The service is stopped: back up and switch here; the service records the outcome when it starts.
    const from = (await currentVersion(prefix)) ?? "unknown";
    const database = await databasePath(context);
    const exists = Boolean(await stat(database).catch(() => null));
    const fromSchema = exists ? databaseSchemaVersion(database) : null;
    const backup = exists ? await backupState({ home: context.paths.home, database, label: `${from}-to-${staged.version}` }) : null;
    await recordThenSwitch(context, { kind: "upgrade", from, to: staged.version, fromSchema, backup }, () => switchCurrent(prefix, staged.version));
    if (context.json) return printJson(context, { from, to: staged.version, backup, running: false });
    context.out(`Switched ${prefix}/current from ${from} to ${staged.version}${backup ? `; backup: ${backup}` : ""}. The service is not running: start it with conveyor service start.`);
  },
};

export const rollback: Command = {
  name: "rollback",
  summary: "return to the release the last upgrade replaced",
  options: {
    "restore-backup": { type: "boolean", description: "also restore the database saved before that upgrade (required when the upgrade migrated it; later work is lost)" },
    ...SWITCH_OPTIONS,
  },
  async run(rawContext) {
    const context = await withUnitHome(rawContext);
    const prefix = await prefixFor(context);
    const restore = context.options["restore-backup"] === true;
    const service = await serviceStatus(context);
    if (service) {
      const { pending } = await control<{ pending: PendingSwitch }>(context, "POST", "/v1/releases", {
        kind: "rollback", prefix, restoreBackup: restore, drainTimeoutMs: timeout(context, "drain-timeout", "30m"),
      });
      if (context.options["no-wait"]) return context.out(`Scheduled the rollback from ${pending.from} to ${pending.version}.`);
      context.err(`Draining: the service rolls back to ${pending.version} once running work finishes...`);
      const record = await waitForSwitch(context, pending, timeout(context, "drain-timeout", "30m") + timeout(context, "wait-timeout", "5m"));
      if (context.json) return printJson(context, record);
      return context.out(`Rolled back from ${record.from} to ${record.to}${pending.restoreBackup ? ` and restored ${pending.restoreBackup}` : ""}; it is running and ready.`);
    }

    const running = await currentVersion(prefix);
    if (!running) throw new CliError(`${prefix}/current does not point at an installed release`, EXIT.failure);
    const database = await databasePath(context);
    const schemaNow = (await stat(database).catch(() => null)) ? databaseSchemaVersion(database) : 0;
    const state = await readReleaseState(context.paths.home);
    let plan;
    try {
      plan = planRollback(state, running, schemaNow, restore);
    } catch (error) {
      if (error instanceof RollbackRefused) throw new CliError(error.message, EXIT.rejected);
      throw error;
    }
    // Check the target is installed before the irreversible restore.
    await requireInstalled(prefix, plan.target).catch((error: unknown) => {
      throw new CliError(`${error instanceof Error ? error.message : String(error)}; nothing was changed`, EXIT.failure);
    });
    await recordThenSwitch(context, { kind: "rollback", from: running, to: plan.target, fromSchema: schemaNow, backup: plan.restoreBackup }, async () => {
      if (plan.restoreBackup) await restoreState(plan.restoreBackup, database);
      await switchCurrent(prefix, plan.target);
    });
    if (context.json) return printJson(context, { from: running, to: plan.target, restored: plan.restoreBackup });
    context.out(`Switched ${prefix}/current from ${running} to ${plan.target}${plan.restoreBackup ? ` and restored ${plan.restoreBackup}` : ""}. Start the service with conveyor service start.`);
  },
};
