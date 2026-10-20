import { describe, expect, test } from "bun:test";

import { serverStatusMetrics } from "../../src/web/server-status";

describe("serverStatusMetrics", () => {
  test("renders live storage pressure, unavailable locations, and shared filesystems clearly", () => {
    const formatBytes = (value: number) => `${value} B`;
    const formatElapsed = (value: number) => `${value}s`;

    const pressured = serverStatusMetrics({
      memory: { usedBytes: 8, totalBytes: 16, processBytes: 2 },
      disk: { available: true, usedBytes: 20, totalBytes: 100, availableBytes: 80 },
      storage: {
        artifacts: { available: true, usedBytes: 86, totalBytes: 100, availableBytes: 14 },
        temporaryDirectory: { available: true, usedBytes: 85, totalBytes: 100, availableBytes: 15 },
        workspaceScratch: { available: false },
      },
      uptimeSeconds: 60,
    }, formatBytes, formatElapsed);
    expect(pressured).toContain("Warning: artifacts 86% used (86 B / 100 B)");
    expect(pressured).toContain("temporary directory 85% used (85 B / 100 B)");
    expect(pressured).not.toContain("Warning: temporary directory");

    const justOverThreshold = serverStatusMetrics({
      memory: { usedBytes: 8, totalBytes: 16, processBytes: 2 },
      disk: { available: true, usedBytes: 20, totalBytes: 100, availableBytes: 80 },
      storage: {
        artifacts: { available: true, usedBytes: 8_504, totalBytes: 10_000, availableBytes: 1_496 },
        temporaryDirectory: { available: true, usedBytes: 8_500, totalBytes: 10_000, availableBytes: 1_500 },
        workspaceScratch: { available: false },
      },
      uptimeSeconds: 60,
    }, formatBytes, formatElapsed);
    expect(justOverThreshold).toContain("Warning: artifacts 85% used");
    expect(justOverThreshold).not.toContain("Warning: agent scratch");

    const sharedAndUnavailable = serverStatusMetrics({
      memory: { usedBytes: 8, totalBytes: 16, processBytes: 2 },
      disk: { available: true, usedBytes: 20, totalBytes: 100, availableBytes: 80 },
      storage: {
        artifacts: { available: true, usedBytes: 90, totalBytes: 100, availableBytes: 10 },
        temporaryDirectory: { available: true, usedBytes: 90, totalBytes: 100, availableBytes: 10, sharesFilesystemWithArtifacts: true },
        workspaceScratch: { available: false },
      },
      uptimeSeconds: 60,
    }, formatBytes, formatElapsed);
    expect(sharedAndUnavailable).toContain("Warning: artifacts and temporary directory 90% used (90 B / 100 B)");
    expect(sharedAndUnavailable.match(/90 B \/ 100 B/g)).toHaveLength(1);

    const unavailable = serverStatusMetrics({
      memory: { usedBytes: 8, totalBytes: 16, processBytes: 2 },
      disk: { available: false },
      storage: { artifacts: { available: false }, temporaryDirectory: { available: false }, workspaceScratch: { available: false } },
      uptimeSeconds: 60,
    }, formatBytes, formatElapsed);
    expect(unavailable).toContain("Disk unavailable");
    expect(unavailable).toContain("artifacts unavailable");
    expect(unavailable).toContain("temporary directory unavailable");
    expect(unavailable).toContain("agent scratch unavailable");
  });
});
