import { statfs } from "node:fs/promises";

export const DISK_PRESSURE_PERCENT = 85;

export interface FilesystemPressure {
  name: "artifacts" | "temporary";
  location: string;
  status: "ok" | "warn" | "unavailable";
  usedBytes?: number;
  totalBytes?: number;
  usedPercent?: number;
  diagnostic?: string;
}

interface FilesystemStats {
  blocks: number;
  bsize: number;
  bavail: number;
}

export type FilesystemMeasure = (location: string) => Promise<FilesystemStats>;

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pressure(
  name: FilesystemPressure["name"],
  location: string,
  measure: FilesystemMeasure,
): Promise<FilesystemPressure> {
  try {
    const stats = await measure(location);
    const totalBytes = stats.blocks * stats.bsize;
    const availableBytes = stats.bavail * stats.bsize;
    if (!Number.isFinite(totalBytes) || !Number.isFinite(availableBytes) || totalBytes <= 0 || availableBytes < 0 || availableBytes > totalBytes) {
      return { name, location, status: "unavailable", diagnostic: "filesystem capacity is invalid" };
    }
    const usedBytes = totalBytes - availableBytes;
    const usedPercent = Math.round((usedBytes / totalBytes) * 1000) / 10;
    return {
      name,
      location,
      status: usedBytes / totalBytes > DISK_PRESSURE_PERCENT / 100 ? "warn" : "ok",
      usedBytes,
      totalBytes,
      usedPercent,
    };
  } catch (error) {
    return { name, location, status: "unavailable", diagnostic: diagnostic(error) };
  }
}

/** Capacity of the filesystems backing Conveyor artifacts and the process temporary directory. */
export async function filesystemPressure(
  locations: { artifacts: string; temporary: string },
  measure: FilesystemMeasure = statfs,
): Promise<FilesystemPressure[]> {
  return Promise.all([
    pressure("artifacts", locations.artifacts, measure),
    pressure("temporary", locations.temporary, measure),
  ]);
}

export function filesystemPressureDetail(result: FilesystemPressure): string {
  if (result.status === "unavailable") return `${result.location}: unavailable (${result.diagnostic})`;
  return `${result.location}: ${result.usedPercent}% full`;
}
