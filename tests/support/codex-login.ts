import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** An unsigned JWT with the given claims; fixture only. */
export function fixtureJwt(claims: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

export const HOUR = 3600;
export function secondsFromNow(offset: number): number {
  return Math.floor(Date.now() / 1000) + offset;
}

/** A ChatGPT login record whose access token is a JWT carrying `marker` and expiring `expiresIn` seconds from now. */
export function chatgptRecord(marker: string, options: { expiresIn?: number; refresh?: string } = {}): Record<string, unknown> {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: fixtureJwt({ exp: secondsFromNow(HOUR), "https://api.openai.com/auth": { chatgpt_account_id: "acct-fixture", chatgpt_plan_type: "plus" }, marker: "REAL-ID-1" }),
      access_token: fixtureJwt({ exp: secondsFromNow(options.expiresIn ?? HOUR), marker }),
      refresh_token: options.refresh ?? "REAL-REFRESH-1",
      account_id: "acct-fixture",
    },
    last_refresh: new Date().toISOString(),
  };
}

export async function writeLogin(serviceHome: string, record: unknown): Promise<string> {
  await mkdir(serviceHome, { recursive: true });
  const file = path.join(serviceHome, "auth.json");
  await writeFile(file, typeof record === "string" ? record : JSON.stringify(record), { mode: 0o600 });
  return file;
}
