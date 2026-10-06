// <home>/run/conveyor.pid marks a serve process from its first moment, before it opens the
// database and long before its control socket answers. Commands that change state directly (with
// the service "stopped") check it, so they never act under a live process.

import { readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const PID_FILE = "conveyor.pid";

/**
 * Claims the home for this serve process. The file is created exclusively, so of two processes
 * starting at once only one wins; an existing file is taken over only when its process is gone.
 * The file is removed when this process exits.
 */
export async function claimPidFile(runDirectory: string): Promise<void> {
  const file = path.join(runDirectory, PID_FILE);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeFile(file, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) {
        const owner = await runningServe(runDirectory);
        throw new Error(owner ? `another Conveyor is already running for this home (pid ${owner})` : `cannot claim ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const owner = await runningServe(runDirectory);
      if (owner) throw new Error(`another Conveyor is already running for this home (pid ${owner})`);
      // Left by a process that is gone: remove it and try once more (exclusively again).
      await rm(file, { force: true });
    }
  }
  process.once("exit", () => {
    // Only our own file: a later process may have claimed it. It may also be gone already.
    try {
      if (readFileSync(file, "utf8").trim() === String(process.pid)) rmSync(file, { force: true });
    } catch {
      // Nothing to clean up.
    }
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
