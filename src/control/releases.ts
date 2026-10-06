// Switching the running service to another installed release (upgrade or rollback) without
// racing the scheduler: the service stops admitting work, waits until nothing runs, backs up its
// state, points <prefix>/current at the new release and exits; systemd starts the new release,
// which records the outcome. A stage that requests its own upgrade (Conveyor delivering itself)
// does not wait for the switch, so it finishes first and the item's next stage runs after restart.

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";

import type { ConveyorService } from "../app/service";
import { log } from "../log/logger";
import { executableOf, requireInstalled, switchCurrent } from "../release/install";
import { compareVersions } from "../release/semver";
import {
  backupState, planRollback, readReleaseState, restoreState, RollbackRefused, writeReleaseState,
  type PendingSwitch, type SwitchRecord,
} from "../release/state";
import { BUILD } from "../version";

export class SwitchRefused extends Error {
  override readonly name = "SwitchRefused";
}

export interface SwitchRequest {
  kind: "upgrade" | "rollback";
  /** The installed version to upgrade to (ignored for a rollback, which returns to the recorded previous version). */
  version?: string;
  prefix: string;
  restoreBackup?: boolean;
  drainTimeoutMs: number;
}

export interface CoordinatorHooks {
  /** Stops the service and exits with `exitCode`; `afterClose` runs once the database is closed. */
  stop(reason: string, exitCode: number, afterClose?: () => Promise<void>): void;
  /** Whether a supervisor (systemd) restarts the process after it exits. */
  supervised: boolean;
  /** Exit code that asks the supervisor for a restart. */
  restartExitCode: number;
}

export class ReleaseCoordinator {
  #timer: ReturnType<typeof setInterval> | null = null;
  #performing = false;

  constructor(
    private readonly service: ConveyorService,
    private readonly home: string,
    private readonly hooks: CoordinatorHooks,
    private readonly pollMs = 1_000,
  ) {}

  /** Records the outcome of a switch that restarted into this process, and drops a stale pending switch. */
  async onStartup(): Promise<void> {
    const state = await readReleaseState(this.home);
    let changed = false;
    const switched = [...state.history].reverse().find((record) => record.status === "switched");
    if (switched) {
      const ok = switched.to === BUILD.version;
      Object.assign(switched, {
        status: ok ? "completed" : "failed",
        toSchema: this.service.store.schemaVersion(),
        finishedAt: new Date().toISOString(),
        reason: ok ? null : `expected ${switched.to} to start, but ${BUILD.version} started`,
      });
      changed = true;
      if (ok) log.info(`${switched.kind === "upgrade" ? "Upgraded" : "Rolled back"} from ${switched.from} to ${switched.to}`, { schema: switched.toSchema });
      else log.error("Release switch failed", { expected: switched.to, running: BUILD.version });
    }
    if (state.pending) {
      state.history.push(this.record(state.pending, { status: "cancelled", reason: "the service restarted before the switch", fromSchema: null, backup: null }));
      log.warn("A pending release switch was cancelled: the service restarted before it ran", { version: state.pending.version });
      state.pending = null;
      changed = true;
    }
    if (changed) await writeReleaseState(this.home, state);
  }

  async pending(): Promise<PendingSwitch | null> {
    return (await readReleaseState(this.home)).pending;
  }

  async schedule(request: SwitchRequest): Promise<PendingSwitch> {
    if (!this.hooks.supervised) {
      throw new SwitchRefused("this Conveyor is not run by systemd, so nothing would start the new release: stop it and run the command again");
    }
    const state = await readReleaseState(this.home);
    if (state.pending) throw new SwitchRefused(`a ${state.pending.kind} to ${state.pending.version} is already pending`);
    let version = request.version;
    let restoreBackup: string | null = null;
    if (request.kind === "rollback") {
      try {
        const plan = planRollback(state, BUILD.version, this.service.store.schemaVersion(), request.restoreBackup === true);
        version = plan.target;
        restoreBackup = plan.restoreBackup;
      } catch (error) {
        if (error instanceof RollbackRefused) throw new SwitchRefused(error.message);
        throw error;
      }
    }
    if (!version) throw new SwitchRefused("no version to switch to");
    if (request.kind === "upgrade" && compareVersions(version, BUILD.version) <= 0) {
      throw new SwitchRefused(version === BUILD.version ? `${version} is already running` : `${version} is older than the running ${BUILD.version}: use conveyor rollback to go back`);
    }
    if (!(await stat(executableOf(request.prefix, version)).catch(() => null))?.isFile()) {
      throw new SwitchRefused(`version ${version} is not installed in ${request.prefix}`);
    }
    const pending: PendingSwitch = {
      id: randomUUID(),
      kind: request.kind,
      version,
      from: BUILD.version,
      prefix: request.prefix,
      restoreBackup,
      requestedAt: new Date().toISOString(),
      drainDeadline: new Date(Date.now() + request.drainTimeoutMs).toISOString(),
    };
    await writeReleaseState(this.home, { ...state, pending });
    this.service.drain(`${request.kind} to ${version}`);
    log.info(`Scheduled ${request.kind} to ${version}: draining`, { from: BUILD.version, deadline: pending.drainDeadline });
    this.watch();
    return pending;
  }

  /** Cancels the pending switch (operator request or drain timeout) and admits work again. */
  async cancel(reason: string): Promise<boolean> {
    const state = await readReleaseState(this.home);
    if (!state.pending || this.#performing) return false;
    state.history.push(this.record(state.pending, { status: "cancelled", reason, fromSchema: null, backup: null }));
    const cancelled = state.pending;
    state.pending = null;
    await writeReleaseState(this.home, state);
    this.stopWatching();
    this.service.resumeAdmission();
    log.warn(`Cancelled the ${cancelled.kind} to ${cancelled.version}`, { reason });
    return true;
  }

  /** Re-arms the watch after a restart of the coordinator (not of the process). */
  watch(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick().catch((error: unknown) => log.error("Release switch failed", {}, error)), this.pollMs);
  }

  private stopWatching(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async tick(): Promise<void> {
    if (this.#performing) return;
    const pending = await this.pending();
    if (!pending) return this.stopWatching();
    const work = this.service.activeWork();
    if (work.items.length === 0 && work.steering === 0) return this.perform(pending);
    if (Date.now() >= Date.parse(pending.drainDeadline)) {
      const running = work.items.map((item) => `${item.repositoryId}/${item.stageId}`).join(", ") || `${work.steering} steering run(s)`;
      await this.cancel(`the drain timed out with work still running (${running})`);
    }
  }

  private record(pending: PendingSwitch, fields: Pick<SwitchRecord, "status" | "reason" | "fromSchema" | "backup">): SwitchRecord {
    return {
      id: pending.id, kind: pending.kind, from: pending.from, to: pending.version, toSchema: null,
      requestedAt: pending.requestedAt, finishedAt: fields.status === "switched" ? null : new Date().toISOString(), ...fields,
    };
  }

  private async perform(pending: PendingSwitch): Promise<void> {
    this.#performing = true;
    this.stopWatching();
    const store = this.service.store;
    const database = store.sqlite().filename;
    try {
      const fromSchema = store.schemaVersion();
      const backup = pending.kind === "upgrade"
        ? await backupState({ home: this.home, database, label: `${pending.from}-to-${pending.version}`, open: store.sqlite() })
        : pending.restoreBackup;
      if (!pending.restoreBackup) await switchCurrent(pending.prefix, pending.version);
      const state = await readReleaseState(this.home);
      state.pending = null;
      state.history.push(this.record(pending, { status: "switched", reason: null, fromSchema, backup }));
      await writeReleaseState(this.home, state);
      log.info(`Idle: switching to ${pending.version}`, { kind: pending.kind, backup });
    } catch (error) {
      // Nothing switched: keep running this release and admit work again.
      const state = await readReleaseState(this.home);
      state.pending = null;
      state.history.push(this.record(pending, { status: "failed", reason: error instanceof Error ? error.message : String(error), fromSchema: null, backup: null }));
      await writeReleaseState(this.home, state);
      this.#performing = false;
      this.service.resumeAdmission();
      log.error(`The ${pending.kind} to ${pending.version} failed before switching; still running ${BUILD.version}`, {}, error);
      return;
    }
    if (pending.restoreBackup) {
      const restore = pending.restoreBackup;
      // The backup can only replace the database once it is closed; then the link switches.
      this.hooks.stop(`rollback to ${pending.version}`, this.hooks.restartExitCode, async () => {
        await requireInstalled(pending.prefix, pending.version);
        await restoreState(restore, database);
        await switchCurrent(pending.prefix, pending.version);
      });
      return;
    }
    this.hooks.stop(`${pending.kind} to ${pending.version}`, this.hooks.restartExitCode);
  }
}
