import { describe, expect, test } from "bun:test";

import { collectSystemStatus } from "../../src/app/service";

describe("collectSystemStatus", () => {
  test("measures configured artifacts and agent scratch filesystems independently", async () => {
    const status = await collectSystemStatus({
      database: "/database",
      artifacts: "/artifacts",
      temporaryDirectory: "/workspaces",
      statfs: async (location: string) => {
        if (location === "/workspaces") throw new Error("workspace scratch filesystem is unavailable");
        if (location === "/artifacts") return { blocks: 100, bsize: 1, bavail: 14 } as never;
        return { blocks: 200, bsize: 1, bavail: 100 } as never;
      },
      memory: { totalBytes: 16, freeBytes: 8, processBytes: 2, uptimeSeconds: 60 },
    });

    expect(status.disk).toEqual({ available: true, usedBytes: 100, totalBytes: 200, availableBytes: 100 });
    expect(status.storage.artifacts).toEqual({ available: true, usedBytes: 86, totalBytes: 100, availableBytes: 14 });
    expect(status.storage.temporaryDirectory).toEqual({ available: false });
  });

  test("marks same artifact and temporary filesystem so the dashboard can avoid duplicate totals", async () => {
    const status = await collectSystemStatus({
      database: "/database",
      artifacts: "/artifacts",
      temporaryDirectory: "/temporary",
      statfs: async (location: string) => location === "/database"
        ? { blocks: 200, bsize: 1, bavail: 100 } as never
        : { blocks: 100, bsize: 1, bavail: 10 } as never,
      stat: async (location: string) => ({ dev: location === "/database" ? 1 : 2 }),
      memory: { totalBytes: 16, freeBytes: 8, processBytes: 2, uptimeSeconds: 60 },
    });

    expect(status.storage.temporaryDirectory.sharesFilesystemWithArtifacts).toBe(true);
  });
});
