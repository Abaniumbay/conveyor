import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { piInstallation } from "../../../src/plugins/pi/launch";
import { installFakePi } from "../../support/fake-pi";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "conveyor-pi-launch-")));
  directories.push(directory);
  return directory;
}

describe("piInstallation", () => {
  test("follows npm's bin link to the CLI script, its package root and the resolved interpreter its #! line names", async () => {
    const root = await temporary();
    const { bin, packageRoot } = await installFakePi(root, "");
    const found = piInstallation("pi", { PATH: `${bin}:${process.env.PATH}` });
    expect(found.executable).toBe(path.join(packageRoot, "dist", "bundle", "cli.js"));
    expect(found.packageRoot).toBe(packageRoot);
    expect(found.interpreter).toEqual({ path: await realpath(Bun.which("bun")!), args: [] });
  });

  test("launches a standalone build directly, with the directory that holds its package.json", async () => {
    const root = await temporary();
    const build = path.join(root, "pi-build");
    await mkdir(build);
    await writeFile(path.join(build, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
    await writeFile(path.join(build, "pi"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0]));
    await chmod(path.join(build, "pi"), 0o755);
    expect(piInstallation(path.join(build, "pi"), { PATH: "" })).toEqual({ executable: path.join(build, "pi"), packageRoot: build });
  });

  test("refuses a command outside pi's package, and a script whose interpreter is not installed", async () => {
    const root = await temporary();
    const loose = path.join(root, "pi");
    await writeFile(loose, "#!/usr/bin/env node\n");
    await chmod(loose, 0o755);
    expect(() => piInstallation(loose, { PATH: "" })).toThrow("is not part of an installed @earendil-works/pi-coding-agent package");

    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
    expect(() => piInstallation(loose, { PATH: path.join(root, "empty") })).toThrow("runs on node, which cannot be found on PATH");
  });
});
