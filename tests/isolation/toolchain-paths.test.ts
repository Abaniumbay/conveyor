import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { agentFilesystemPlan } from "../../src/isolation/sandbox";
import { agentToolchainPathsSchema, resolveToolchainPaths } from "../../src/isolation/toolchain-paths";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "conveyor-toolchain-")));
  directories.push(directory);
  return directory;
}

describe("agentToolchainPaths schema", () => {
  test("accepts an absolute path", () => {
    expect(agentToolchainPathsSchema.safeParse({ paths: ["/opt/sdk"] }).success).toBe(true);
  });

  test("rejects an unknown key", () => {
    expect(agentToolchainPathsSchema.safeParse({ paths: ["/opt/sdk"], writable: true }).success).toBe(false);
  });

  test("rejects a relative path", () => {
    expect(agentToolchainPathsSchema.safeParse({ paths: ["sdk/bin"] }).success).toBe(false);
  });
});

describe("resolveToolchainPaths", () => {
  test("refuses a path inside, equal to, or above a protected location", async () => {
    const root = await temporary();
    const secret = path.join(root, "home", "data");
    await mkdir(secret, { recursive: true });
    for (const declared of [secret, path.join(secret, "child"), path.join(root, "home"), "/"]) {
      expect(() => resolveToolchainPaths([declared], [secret])).toThrow("protected service location");
    }
  });

  test("refuses a symbolic link into a protected location", async () => {
    const root = await temporary();
    const secret = path.join(root, "data");
    await mkdir(secret);
    const link = path.join(root, "sdk-link");
    await symlink(secret, link);
    expect(() => resolveToolchainPaths([link], [secret])).toThrow(/resolves to .*protected service location/);
  });

  test("returns the real path of an allowed link", async () => {
    const root = await temporary();
    const sdk = path.join(root, "sdk");
    await mkdir(sdk);
    const link = path.join(root, "sdk-link");
    await symlink(sdk, link);
    expect(resolveToolchainPaths([link], [path.join(root, "data")])).toEqual([sdk]);
  });
});

describe("agentFilesystemPlan toolchain mounts", () => {
  async function run() {
    const root = await temporary();
    const make = async (name: string) => { await mkdir(path.join(root, name)); return path.join(root, name); };
    const options = {
      command: process.execPath, env: { PATH: process.env.PATH ?? "" },
      workspace: await make("ws"), artifacts: await make("art"), home: await make("home"), scratch: await make("scratch"),
    };
    return { root, options, sdk: await make("sdk") };
  }

  test("mounts a declared toolchain path read-only", async () => {
    const { options, sdk } = await run();
    const { mounts } = agentFilesystemPlan({ ...options, toolchain: [sdk] });
    const at = mounts.findIndex((value, index) => value === sdk && mounts[index + 1] === sdk);
    expect(mounts[at - 1]).toBe("--ro-bind");
  });

  test("fails the plan when a toolchain path is missing or overlaps run material", async () => {
    const { root, options } = await run();
    expect(() => agentFilesystemPlan({ ...options, toolchain: [path.join(root, "absent")] })).toThrow("cannot be mounted");
    expect(() => agentFilesystemPlan({ ...options, toolchain: [options.workspace] })).toThrow("overlaps run path");
    expect(() => agentFilesystemPlan({ ...options, toolchain: [root] })).toThrow("overlaps run path");
  });
});
