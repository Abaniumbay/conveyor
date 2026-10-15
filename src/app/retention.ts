// Retention of finished work (settings.retention): run events and per-run artifact directories of
// runs whose item is closed, done or offboarded, once older than the configured age. Terminal run
// homes are reclaimed independently, even for open items; running homes are never touched. Service
// log retention is separate (settings.logging).

import { lstat, readdir, rm, stat } from "node:fs/promises";
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
  /** Per-run sanitized homes, reclaimed independently of artifact and event retention. */
  homes: { directories: number; bytes: number; failures: string[] };
}

async function size(target: string): Promise<number> {
  const info = await lstat(target).catch(() => null);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(target).catch(() => [] as string[])) total += await size(path.join(target, entry));
  return total;
}

/** Apparent size without following a symlink outside the selected private home. */
async function homeSize(target: string): Promise<number> {
  const info = await lstat(target);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(target)) total += await homeSize(path.join(target, entry));
  return total;
}

function runHome(artifacts: string, runId: string): { directory: string; home: string } | null {
  const root = path.resolve(artifacts);
  const directory = path.resolve(root, runId);
  const home = path.resolve(directory, "home");
  return path.dirname(directory) === root && path.dirname(home) === directory ? { directory, home } : null;
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
  const report: RetentionReport = {
    dryRun,
    runHistory: { runs: 0, events: 0 },
    artifacts: { directories: 0, bytes: 0 },
    homes: { directories: 0, bytes: 0, failures: [] },
  };
  const selectedHomeBytes = new Map<string, number>();
  let artifactEntries: string[];
  try {
    artifactEntries = await readdir(input.artifacts);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
      report.homes.failures.push(`artifact directory: ${error instanceof Error ? error.message : String(error)}`);
    }
    artifactEntries = [];
  }
  for (const runId of artifactEntries) {
    const run = input.store.getRun(runId);
    if (!run || run.status === "running" || run.finishedAt === null) continue;
    const selected = runHome(input.artifacts, run.id);
    if (!selected) continue;
    try {
      const directory = await lstat(selected.directory);
      if (!directory.isDirectory()) {
        report.homes.failures.push(`${run.id}: run artifact directory is not a directory`);
        continue;
      }
      await lstat(selected.home);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
      report.homes.failures.push(`${run.id}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const { home } = selected;
    let bytes: number;
    try {
      bytes = await homeSize(home);
    } catch (error) {
      report.homes.failures.push(`${run.id}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (dryRun) {
      report.homes.directories += 1;
      report.homes.bytes += bytes;
      selectedHomeBytes.set(selected.directory, bytes);
      continue;
    }
    try {
      await rm(home, { recursive: true, force: false });
      report.homes.directories += 1;
      report.homes.bytes += bytes;
    } catch (error) {
      report.homes.failures.push(`${run.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
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
      const bytes = await size(directory);
      report.artifacts.bytes += dryRun ? Math.max(0, bytes - (selectedHomeBytes.get(path.resolve(directory)) ?? 0)) : bytes;
      if (!dryRun) await rm(directory, { recursive: true, force: true });
    }
  }
  return report;
}
