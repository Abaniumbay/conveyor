import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveFilesystemPath, resolvePathEnvironment } from "../../src/core/paths";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("resolveFilesystemPath", () => {
  test("uses the real existing parent for a path reached through a symbolic link", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-paths-"));
    directories.push(root);
    const target = path.join(root, "target");
    const link = path.join(root, "link");
    await mkdir(target);
    await symlink(target, link);

    expect(resolveFilesystemPath(path.join(link, "new", "output.json")))
      .toBe(path.join(target, "new", "output.json"));
  });

  test("resolves single path environment values without changing path lists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-paths-"));
    directories.push(root);
    const target = path.join(root, "target");
    const link = path.join(root, "link");
    await mkdir(target);
    await symlink(target, link);

    expect(resolvePathEnvironment({ CACHE_DIR: link, PATH: "/usr/bin:/bin", MODE: "safe" })).toEqual({
      CACHE_DIR: target,
      PATH: "/usr/bin:/bin",
      MODE: "safe",
    });
  });
});
