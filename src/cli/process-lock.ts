// <home>/run/conveyor.pid marks a serve process from its first moment, before it opens the
// database and long before its control socket answers. Commands that change state directly (with
// the service "stopped") check it, so they never act under a live process.

import { readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const PID_FILE = "conveyor.pid";

/** Records this process as the home's serve process; the file is removed when the process exits. */
export async function claimPidFile(runDirectory: string): Promise<void> {
  const file = path.join(runDirectory, PID_FILE);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await writeFile(file, `${process.pid}\n`, { mode: 0o600 });
  process.once("exit", () => {
    // Only our own file: a later process may have claimed it.
    if (readFileSync(file, "utf8").trim() === String(process.pid)) rmSync(file, { force: true });
  });
}

/** The pid of a live serve process for this home, or null (no file, a dead pid, or a reused one). */
export async function runningServe(runDirectory: string): Promise<number | null> {
  const pid = Number((await readFile(path.join(runDirectory, PID_FILE), "utf8").catch(() => "")).trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return null;
  }
  // A recycled pid belongs to some other program: only a conveyor serve counts.
  const commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => null);
  return commandLine === null || commandLine.split("\0").includes("serve") ? pid : null;
}
