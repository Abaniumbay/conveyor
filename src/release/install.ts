// The installed-release layout that install.sh creates and upgrade/rollback maintain:
//   <prefix>/versions/<version>/conveyor   one directory per installed release
//   <prefix>/current -> versions/<version> the release that runs (the service unit starts current/conveyor)
// Releases are downloaded from GitHub Releases (or given as files), verified against checksums.txt
// and staged before anything switches.

import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const DEFAULT_REPOSITORY = "Abaniumbay/conveyor";

export class ReleaseError extends Error {
  override readonly name = "ReleaseError";
}

export interface InstallLayout {
  prefix: string;
  versions: string;
  current: string;
}

export function layout(prefix: string): InstallLayout {
  return { prefix, versions: path.join(prefix, "versions"), current: path.join(prefix, "current") };
}

export function executableOf(prefix: string, version: string): string {
  return path.join(layout(prefix).versions, version, "conveyor");
}

/** The prefix this executable was installed into, when it runs from <prefix>/versions/<version>/conveyor. */
export async function detectPrefix(executable: string = process.execPath): Promise<string | null> {
  const resolved = await realpath(executable).catch(() => executable);
  const versionDirectory = path.dirname(resolved);
  const versions = path.dirname(versionDirectory);
  if (path.basename(resolved) !== "conveyor" || path.basename(versions) !== "versions") return null;
  return path.dirname(versions);
}

/** The version <prefix>/current points at, or null. */
export async function currentVersion(prefix: string): Promise<string | null> {
  const target = await readlink(layout(prefix).current).catch(() => null);
  return target ? path.basename(target) : null;
}

export async function installedVersions(prefix: string): Promise<string[]> {
  const entries = await readdir(layout(prefix).versions, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && !entry.name.endsWith(".partial")).map((entry) => entry.name).sort();
}

/** Throws unless `version` is installed in `prefix`; check it before anything irreversible. */
export async function requireInstalled(prefix: string, version: string): Promise<void> {
  if (!(await stat(executableOf(prefix, version)).catch(() => null))?.isFile()) throw new ReleaseError(`version ${version} is not installed in ${prefix}`);
}

/** Points <prefix>/current at `version` atomically: a new link is renamed over the old one. */
export async function switchCurrent(prefix: string, version: string): Promise<void> {
  await requireInstalled(prefix, version);
  const { current } = layout(prefix);
  const temporary = `${current}.${process.pid}.new`;
  await rm(temporary, { force: true });
  await symlink(path.join("versions", version), temporary);
  await rename(temporary, current);
}

/** A tag such as v0.2.0 (a leading v is added when missing). */
export function releaseTag(version: string): string {
  if (!/^v?\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(version)) throw new ReleaseError(`not a release version: ${version}`);
  return version.startsWith("v") ? version : `v${version}`;
}

export function platformTarget(): string {
  if (process.platform !== "linux") throw new ReleaseError(`Conveyor releases support Linux only (this is ${process.platform})`);
  if (process.arch === "x64") return "linux-x64";
  if (process.arch === "arm64") return "linux-arm64";
  throw new ReleaseError(`unsupported CPU architecture: ${process.arch}`);
}

export interface ReleaseFiles {
  archive: string;
  checksums: string;
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" }).catch((error: unknown) => {
    throw new ReleaseError(`cannot download ${url}: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!response.ok) throw new ReleaseError(`cannot download ${url}: HTTP ${response.status}`);
  await writeFile(destination, new Uint8Array(await response.arrayBuffer()));
}

/** Downloads a release's archive for this platform and its checksums into a temporary directory. */
export async function downloadRelease(tag: string, repository = process.env.CONVEYOR_REPOSITORY ?? DEFAULT_REPOSITORY): Promise<ReleaseFiles & { cleanup(): Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-release-"));
  const name = `conveyor-${tag}-${platformTarget()}.tar.gz`;
  const base = `https://github.com/${repository}/releases/download/${tag}`;
  try {
    await download(`${base}/${name}`, path.join(directory, name));
    await download(`${base}/checksums.txt`, path.join(directory, "checksums.txt"));
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { archive: path.join(directory, name), checksums: path.join(directory, "checksums.txt"), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

/** Throws unless the archive's SHA-256 matches its entry in checksums.txt. */
export async function verifyChecksum(files: ReleaseFiles): Promise<string> {
  const name = path.basename(files.archive);
  const listing = await readFile(files.checksums, "utf8");
  const expected = listing.split("\n").map((line) => line.trim().split(/\s+/)).find((parts) => parts[1] === name)?.[0];
  if (!expected) throw new ReleaseError(`checksums.txt has no entry for ${name}`);
  const actual = createHash("sha256").update(await readFile(files.archive)).digest("hex");
  if (actual !== expected) throw new ReleaseError(`checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
  return actual;
}

async function run(argv: string[]): Promise<string> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new ReleaseError(`${path.basename(argv[0]!)} failed: ${stderr.trim() || stdout.trim() || `exit ${code}`}`);
  return stdout.trim();
}

/**
 * Verifies and unpacks a release archive into <prefix>/versions/<version> (replacing a partial
 * copy, keeping an existing complete one) and returns the version the executable reports.
 */
export async function stageRelease(files: ReleaseFiles, prefix: string): Promise<{ version: string; executable: string; sha256: string }> {
  const sha256 = await verifyChecksum(files);
  const work = await mkdtemp(path.join(tmpdir(), "conveyor-stage-"));
  try {
    await run(["tar", "-C", work, "-xzf", files.archive]);
    const unpacked = path.join(work, path.basename(files.archive).replace(/\.tar\.gz$/, ""));
    const executable = path.join(unpacked, "conveyor");
    if (!(await stat(executable).catch(() => null))?.isFile()) throw new ReleaseError(`${path.basename(files.archive)} does not contain the conveyor executable`);
    const version = (await run([executable, "--version"])).split(" ")[1];
    if (!version) throw new ReleaseError("the release executable did not report its version");
    const { versions } = layout(prefix);
    const destination = path.join(versions, version);
    if ((await stat(path.join(destination, "conveyor")).catch(() => null))?.isFile()) {
      return { version, executable: path.join(destination, "conveyor"), sha256 };
    }
    const partial = `${destination}.partial`;
    await rm(partial, { recursive: true, force: true });
    await mkdir(partial, { recursive: true });
    for (const file of ["conveyor", "LICENSE", "THIRD_PARTY_NOTICES.txt"]) {
      await copyFile(path.join(unpacked, file), path.join(partial, file)).catch((error: unknown) => {
        if (file === "conveyor") throw error;
      });
    }
    await chmod(path.join(partial, "conveyor"), 0o755);
    await rename(partial, destination);
    return { version, executable: path.join(destination, "conveyor"), sha256 };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
