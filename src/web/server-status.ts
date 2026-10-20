// The server status line the dashboard header shows: memory, disks and uptime, with a warning when
// storage runs short. Shared by the page script (spliced in by source) and the browser application.

import type { FilesystemStatusViewModel, SystemStatusViewModel } from "./types";

export function serverStatusMetrics(
  status: SystemStatusViewModel,
  formatBytes: (value: number) => string,
  formatElapsed: (value: number) => string,
): string {
  const filesystem = (label: string, measurement: FilesystemStatusViewModel): string => {
    if (!measurement.available || measurement.usedBytes === undefined || measurement.totalBytes === undefined) return `${label} unavailable`;
    const ratio = measurement.usedBytes / measurement.totalBytes;
    const fullness = Math.round(ratio * 1_000) / 10;
    const warning = ratio > 0.85 ? "Warning: " : "";
    return `${warning}${label} ${fullness}% used (${formatBytes(measurement.usedBytes)} / ${formatBytes(measurement.totalBytes)})`;
  };
  const artifacts = status.storage.artifacts;
  const temporaryDirectory = status.storage.temporaryDirectory;
  const workspaceScratch = status.storage.workspaceScratch;
  const storage = temporaryDirectory.sharesFilesystemWithArtifacts && workspaceScratch.sharesFilesystemWithArtifacts && artifacts.available
    ? filesystem("artifacts, temporary directory, and agent scratch", artifacts)
    : temporaryDirectory.sharesFilesystemWithArtifacts && artifacts.available
      ? `${filesystem("artifacts and temporary directory", artifacts)} · ${filesystem("agent scratch", workspaceScratch)}`
      : workspaceScratch.sharesFilesystemWithArtifacts && artifacts.available
        ? `${filesystem("artifacts and agent scratch", artifacts)} · ${filesystem("temporary directory", temporaryDirectory)}`
        : `${filesystem("artifacts", artifacts)} · ${filesystem("temporary directory", temporaryDirectory)} · ${filesystem("agent scratch", workspaceScratch)}`;
  return `Memory ${formatBytes(status.memory.usedBytes)} / ${formatBytes(status.memory.totalBytes)} · ${filesystem("Disk", status.disk)} · ${storage} · App ${formatBytes(status.memory.processBytes)} · Up ${formatElapsed(status.uptimeSeconds)}`;
}

export function serverStatusHasPressure(status: SystemStatusViewModel): boolean {
  return Object.values(status.storage).some((measurement) => measurement.available
    && measurement.usedBytes !== undefined
    && measurement.totalBytes !== undefined
    && measurement.totalBytes > 0
    && measurement.usedBytes / measurement.totalBytes > 0.85);
}
