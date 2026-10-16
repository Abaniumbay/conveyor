import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MAX_SOCKET_PATH } from "../../src/isolation/run-network";

interface ShortTemporaryDirectoryOptions {
  /** A socket path relative to the created directory that must fit the Unix-socket limit. */
  socketPath?: string;
  /** Bubblewrap masks /tmp, so fixtures used by a sandboxed child must stay outside it. */
  visibleInSandbox?: boolean;
}

function candidates(): string[] {
  // Restricted workspaces can expose conventional temporary directories as
  // read-only while leaving the standard shared-memory runtime mount writable.
  return [...new Set([tmpdir(), "/tmp", "/var/tmp", "/dev/shm"])];
}

function isHiddenBySandbox(directory: string): boolean {
  return directory === "/tmp" || directory.startsWith("/tmp/");
}

/** Creates a writable test fixture directory that leaves enough room for a Unix-domain socket. */
export async function shortTemporaryDirectory(prefix: string, options: ShortTemporaryDirectoryOptions = {}): Promise<string> {
  const socketPath = options.socketPath ?? "";
  const failures: string[] = [];
  for (const base of candidates()) {
    let directory: string | undefined;
    try {
      directory = await mkdtemp(path.join(base, prefix));
      const resolved = await realpath(directory);
      const socket = path.join(resolved, socketPath);
      if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) {
        failures.push(`${base} leaves ${Buffer.byteLength(socket)} bytes for ${socketPath}`);
      } else if (options.visibleInSandbox && isHiddenBySandbox(resolved)) {
        failures.push(`${base} is hidden by Bubblewrap's private /tmp`);
      } else {
        return resolved;
      }
    } catch (error) {
      failures.push(`${base} is not writable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  throw new Error(`could not create a short temporary test directory (${failures.join("; ")})`);
}
