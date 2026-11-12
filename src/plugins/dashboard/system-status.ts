// The server status the dashboard shows beside its model: memory, the database disk, and the
// filesystems of artifacts, the temporary directory and agent scratch space.

import { stat, statfs } from "node:fs/promises";
import { freemem, totalmem, uptime } from "node:os";

import type { FilesystemStatusViewModel, SystemStatusViewModel } from "../../web/types";

type StatfsReader = (location: string) => Promise<{ blocks: number; bsize: number; bavail: number }>;
type StatReader = (location: string) => Promise<{ dev: number }>;

/** Reads the server status; `statfs`, `stat` and `memory` stand in for the system's own reads. */
export async function collectSystemStatus(options: {
  database: string;
  artifacts: string;
  temporaryDirectory: string;
  workspaceScratch: string;
  statfs?: StatfsReader;
  stat?: StatReader;
  memory?: { totalBytes: number; freeBytes: number; processBytes: number; uptimeSeconds: number };
}): Promise<SystemStatusViewModel> {
  const readStatfs: StatfsReader = options.statfs ?? statfs;
  const readStat: StatReader = options.stat ?? stat;
  const filesystem = async (location: string): Promise<{ status: FilesystemStatusViewModel; device: number | null }> => {
    try {
      const stats = await readStatfs(location);
      const totalBytes = stats.blocks * stats.bsize;
      const availableBytes = stats.bavail * stats.bsize;
      if (!Number.isFinite(totalBytes) || !Number.isFinite(availableBytes) || totalBytes <= 0 || availableBytes < 0) {
        return { status: { available: false }, device: null };
      }
      const device = await readStat(location).then(({ dev }) => dev).catch(() => null);
      return { status: { available: true, usedBytes: totalBytes - availableBytes, totalBytes, availableBytes }, device };
    } catch {
      return { status: { available: false }, device: null };
    }
  };
  const [diskMeasurement, artifactsMeasurement, temporaryMeasurement, workspaceScratchMeasurement] = await Promise.all([
    filesystem(options.database), filesystem(options.artifacts), filesystem(options.temporaryDirectory), filesystem(options.workspaceScratch),
  ]);
  const memory = options.memory ?? {
    totalBytes: totalmem(), freeBytes: freemem(), processBytes: process.memoryUsage().rss, uptimeSeconds: Math.floor(uptime()),
  };
  const sharesFilesystem = artifactsMeasurement.device !== null && artifactsMeasurement.device === temporaryMeasurement.device;
  const workspaceScratchSharesFilesystem = artifactsMeasurement.device !== null
    && artifactsMeasurement.device === workspaceScratchMeasurement.device;
  return {
    memory: { usedBytes: memory.totalBytes - memory.freeBytes, totalBytes: memory.totalBytes, processBytes: memory.processBytes },
    disk: diskMeasurement.status,
    storage: {
      artifacts: artifactsMeasurement.status,
      temporaryDirectory: sharesFilesystem
        ? { ...temporaryMeasurement.status, sharesFilesystemWithArtifacts: true }
        : temporaryMeasurement.status,
      workspaceScratch: workspaceScratchSharesFilesystem
        ? { ...workspaceScratchMeasurement.status, sharesFilesystemWithArtifacts: true }
        : workspaceScratchMeasurement.status,
    },
    uptimeSeconds: memory.uptimeSeconds,
  };
}
