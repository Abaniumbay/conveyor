import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const INSTALL = path.resolve(import.meta.dir, "../../scripts/install.sh");
const ARCH = process.arch === "arm64" ? "arm64" : "x64";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function release(root: string, version: string) {
  const name = `conveyor-v${version}-linux-${ARCH}`;
  const directory = path.join(root, "build", name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "conveyor"), `#!/bin/sh\necho "conveyor ${version} (test)"\n`);
  await chmod(path.join(directory, "conveyor"), 0o755);
  await writeFile(path.join(directory, "LICENSE"), "MIT\n");
  await writeFile(path.join(directory, "THIRD_PARTY_NOTICES.txt"), "notices\n");
  const archive = path.join(root, `${name}.tar.gz`);
  Bun.spawnSync(["tar", "-C", path.join(root, "build"), "-czf", archive, name]);
  const checksums = path.join(root, `checksums-${version}.txt`);
  await writeFile(checksums, `${createHash("sha256").update(await readFile(archive)).digest("hex")}  ${name}.tar.gz\n`);
  return { archive, checksums };
}

function install(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["sh", INSTALL, "--prefix", path.join(root, "prefix"), "--bin-dir", path.join(root, "bin"), ...args], {
    env: { HOME: root, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe",
  });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("install.sh", () => {
  test("verifies the archive, installs it into versions/<version> and links current and the bin entry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-install-"));
    directories.push(root);
    const first = await release(root, "1.0.0");
    const result = install(root, "--archive", first.archive, "--checksums", first.checksums);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Installed Conveyor 1.0.0");
    expect(await readlink(path.join(root, "prefix/current"))).toBe("versions/1.0.0");
    expect(await readlink(path.join(root, "bin/conveyor"))).toBe(path.join(root, "prefix/current/conveyor"));
    expect(await readFile(path.join(root, "prefix/versions/1.0.0/THIRD_PARTY_NOTICES.txt"), "utf8")).toBe("notices\n");

    const second = await release(root, "1.1.0");
    expect(install(root, "--archive", second.archive, "--checksums", second.checksums).code).toBe(0);
    expect(await readlink(path.join(root, "prefix/current"))).toBe("versions/1.1.0");
    expect(Bun.spawnSync([path.join(root, "bin/conveyor")]).stdout.toString()).toBe("conveyor 1.1.0 (test)\n");
    expect(await readFile(path.join(root, "prefix/versions/1.0.0/conveyor"), "utf8")).toContain("1.0.0");
  });

  test("refuses an archive whose checksum does not match, installing nothing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-install-"));
    directories.push(root);
    const tampered = await release(root, "1.0.0");
    await writeFile(tampered.checksums, `${"0".repeat(64)}  ${path.basename(tampered.archive)}\n`);
    const result = install(root, "--archive", tampered.archive, "--checksums", tampered.checksums);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("checksum mismatch");
    expect(await readlink(path.join(root, "prefix/current")).catch(() => null)).toBeNull();
  });

  test("rejects unknown options and an archive without checksums", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "conveyor-install-"));
    directories.push(root);
    expect(install(root, "--nope").code).toBe(2);
    expect(install(root, "--archive", "x.tar.gz").stderr).toContain("--archive needs --checksums");
  });
});
