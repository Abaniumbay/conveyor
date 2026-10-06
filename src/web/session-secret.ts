// The dashboard session-signing secret. An explicit secret (`web.sessionSecret`, else
// CONVEYOR_SESSION_SECRET) wins; otherwise one is generated once and kept beside the database, so
// sessions survive restarts and upgrades and the secret is backed up with the state.

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const SESSION_SECRET_FILE = "session-secret";

export async function resolveSessionSecret(
  configured: string | undefined,
  database: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const explicit = configured ?? environment.CONVEYOR_SESSION_SECRET;
  if (explicit) return explicit;
  const file = path.join(path.dirname(database), SESSION_SECRET_FILE);
  const existing = (await readFile(file, "utf8").catch(() => "")).trim();
  if (existing) return existing;
  await mkdir(path.dirname(file), { recursive: true });
  const secret = randomBytes(32).toString("base64url");
  // `wx` fails if another process created it first; then read the winner's secret.
  try {
    await writeFile(file, `${secret}\n`, { mode: 0o600, flag: "wx" });
    await chmod(file, 0o600);
    return secret;
  } catch {
    return (await readFile(file, "utf8")).trim();
  }
}
