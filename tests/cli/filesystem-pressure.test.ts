import { describe, expect, test } from "bun:test";

import { filesystemPressure } from "../../src/cli/filesystem-pressure";

const locations = { artifacts: "/srv/conveyor/artifacts", temporary: "/var/tmp" };
const measured = (values: Record<string, { blocks: number; bsize: number; bavail: number }>) => async (location: string) => {
  const value = values[location];
  if (!value) throw new Error(`cannot measure ${location}`);
  return value;
};

describe("filesystem pressure", () => {
  test("distinguishes artifact and temporary filesystems below, at, and above the strict 85% threshold", async () => {
    const below = await filesystemPressure(locations, measured({
      "/srv/conveyor/artifacts": { blocks: 100, bsize: 1, bavail: 16 },
      "/var/tmp": { blocks: 100, bsize: 1, bavail: 16 },
    }));
    expect(below.map(({ name, status, usedPercent }) => ({ name, status, usedPercent }))).toEqual([
      { name: "artifacts", status: "ok", usedPercent: 84 },
      { name: "temporary", status: "ok", usedPercent: 84 },
    ]);

    const equal = await filesystemPressure(locations, measured({
      "/srv/conveyor/artifacts": { blocks: 100, bsize: 1, bavail: 15 },
      "/var/tmp": { blocks: 100, bsize: 1, bavail: 15 },
    }));
    expect(equal.map(({ name, status, usedPercent }) => ({ name, status, usedPercent }))).toEqual([
      { name: "artifacts", status: "ok", usedPercent: 85 },
      { name: "temporary", status: "ok", usedPercent: 85 },
    ]);

    const above = await filesystemPressure(locations, measured({
      "/srv/conveyor/artifacts": { blocks: 100, bsize: 1, bavail: 14 },
      "/var/tmp": { blocks: 100, bsize: 1, bavail: 14 },
    }));
    expect(above.map(({ name, status, usedPercent }) => ({ name, status, usedPercent }))).toEqual([
      { name: "artifacts", status: "warn", usedPercent: 86 },
      { name: "temporary", status: "warn", usedPercent: 86 },
    ]);
  });

  test("keeps the other filesystem result and identifies an unavailable measurement", async () => {
    const results = await filesystemPressure(locations, measured({
      "/srv/conveyor/artifacts": { blocks: 100, bsize: 1, bavail: 10 },
    }));

    expect(results[0]).toMatchObject({ name: "artifacts", status: "warn", usedPercent: 90 });
    expect(results[1]).toEqual({
      name: "temporary",
      location: "/var/tmp",
      status: "unavailable",
      diagnostic: "cannot measure /var/tmp",
    });
  });
});
