// Retention of finished work (settings.retention): run events and per-run artifact directories of
// runs whose item is closed, done or offboarded, once older than the configured age. Open items are
// never touched, so active, parked and stopped work keeps everything it needs to resume. Service
// log retention is separate (settings.logging).

import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { ConveyorStore } from "../db/store";

export interface RetentionPolicy {
  /** Run events older than this are deleted; null keeps them. */
  runHistoryMs: number | null;
  /** Per-run artifact directories older than this are deleted; null keeps them. */
  artifactsMs: number | null;
}

export interface RetentionReport {
  dryRun: boolean;
  runHistory: { runs: number; events: number };
  artifacts: { directories: number; bytes: number };
}

async function size(target: string): Promise<number> {
  const info = await stat(target).catch(() => null);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(target).catch(() => [] as string[])) total += await size(path.join(target, entry));
  return total;
}

export async function applyRetention(input: {
  store: ConveyorStore;
  artifacts: string;
  policy: RetentionPolicy;
  now?: Date;
  dryRun?: boolean;
}): Promise<RetentionReport> {
  const now = input.now ?? new Date();
  const dryRun = input.dryRun === true;
  const report: RetentionReport = { dryRun, runHistory: { runs: 0, events: 0 }, artifacts: { directories: 0, bytes: 0 } };
  if (input.policy.runHistoryMs !== null) {
    const runs = input.store.listRetiredRuns(new Date(now.getTime() - input.policy.runHistoryMs).toISOString()).filter((run) => run.events > 0);
    report.runHistory = { runs: runs.length, events: runs.reduce((total, run) => total + run.events, 0) };
    if (!dryRun && runs.length > 0) input.store.deleteRunEvents(runs.map((run) => run.id));
  }
  if (input.policy.artifactsMs !== null) {
    const runs = input.store.listRetiredRuns(new Date(now.getTime() - input.policy.artifactsMs).toISOString());
    for (const run of runs) {
      const directory = path.join(input.artifacts, run.id);
      // Run ids are UUIDs: never follow anything that could leave the artifacts directory.
      if (path.dirname(path.resolve(directory)) !== path.resolve(input.artifacts) || !(await stat(directory).catch(() => null))?.isDirectory()) continue;
      report.artifacts.directories += 1;
      report.artifacts.bytes += await size(directory);
      if (!dryRun) await rm(directory, { recursive: true, force: true });
    }
  }
  return report;
}
