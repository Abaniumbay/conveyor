// The host side of a routed Codex run: the real login stays in the service's Codex home and is read
// here for every relayed request. An expired ChatGPT access token is refreshed on the host, one
// refresh at a time, and the record is replaced atomically; the run never sees any of it.

import { chmod, rename, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import path from "node:path";

import { readRegularFile } from "./home";

/** Codex's public OAuth client and the endpoint it refreshes ChatGPT tokens against. */
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

// Codex itself refreshes a login that has not been refreshed for 8 days; an access token that is a
// JWT is refreshed when it expires (with a minute of slack for the request in flight).
const STALE_AFTER_MS = 8 * 24 * 3600_000;
const EXPIRY_SLACK_MS = 60_000;
const REFRESH_TIMEOUT_MS = 30_000;
const MAX_REFRESH_RESPONSE = 1_000_000;

export type CodexLoginMode = "chatgpt" | "apikey";

export interface CodexCredentialSourceOptions {
  /** The service's Codex home, holding the real `auth.json`. */
  serviceHome: string;
  mode: CodexLoginMode;
  /** Test seams: the token endpoint, its trust anchor and the clock. */
  tokenUrl?: string | undefined;
  ca?: string | Buffer | undefined;
  now?: () => number;
}

type Json = Record<string, unknown>;

export function parseRecord(content: Buffer | undefined): Json | undefined {
  if (!content) return undefined;
  try {
    const value = JSON.parse(content.toString("utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function tokensOf(record: Json): Json | undefined {
  const tokens = record.tokens;
  return typeof tokens === "object" && tokens !== null && !Array.isArray(tokens) ? (tokens as Json) : undefined;
}

/** The claims of a JWT (not verified: the host only reads the expiry it was given). */
export function jwtClaims(token: string): Json | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const value = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
  } catch {
    return undefined;
  }
}

function isStale(record: Json, accessToken: string, now: number): boolean {
  const expiry = jwtClaims(accessToken)?.exp;
  if (typeof expiry === "number") return expiry * 1000 <= now + EXPIRY_SLACK_MS;
  const refreshed = typeof record.last_refresh === "string" ? Date.parse(record.last_refresh) : Number.NaN;
  return !Number.isFinite(refreshed) || refreshed + STALE_AFTER_MS <= now;
}

function postJson(url: string, body: string, ca: string | Buffer | undefined): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== "https:") {
      reject(new Error("the token endpoint must use https"));
      return;
    }
    const request = https.request({
      host: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      agent: false,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      ...(ca ? { ca } : {}),
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_REFRESH_RESPONSE) request.destroy(new Error("token endpoint answer too large"));
        else chunks.push(chunk);
      });
      response.once("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      response.once("error", reject);
    });
    request.setTimeout(REFRESH_TIMEOUT_MS, () => request.destroy(new Error("token refresh timed out")));
    request.once("error", reject);
    request.end(body);
  });
}

/** Replaces the record atomically: a complete temporary file in the same directory, then a rename. */
async function replaceRecord(file: string, record: Json): Promise<void> {
  const temporary = path.join(path.dirname(file), `.auth.json.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Refreshes in flight or queued per record, shared by every source of the same login (concurrent runs). */
const refreshQueues = new Map<string, Promise<unknown>>();

/** Runs `task` after every earlier refresh of `file`; `task` re-reads the record, so it sees their result. */
function serialized(file: string, task: () => Promise<string>): Promise<string> {
  const run = (refreshQueues.get(file) ?? Promise.resolve()).catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  refreshQueues.set(file, tail);
  void tail.then(() => { if (refreshQueues.get(file) === tail) refreshQueues.delete(file); });
  return run;
}

/**
 * Returns the function the credential relay calls for every request. It re-reads the record each
 * time (a login rotated on the host applies at once), refuses anything but a regular, well-formed
 * record of the expected mode, and throws (so the relay fails closed) when there is no usable
 * credential. Errors never carry token values.
 */
export function codexCredentialSource(options: CodexCredentialSourceOptions): () => Promise<string> {
  const file = path.join(options.serviceHome, "auth.json");
  const now = options.now ?? Date.now;

  async function refresh(): Promise<string> {
    const record = parseRecord(await readRegularFile(file));
    const tokens = record ? tokensOf(record) : undefined;
    const refreshToken = text(tokens?.refresh_token);
    // A request that read the old record just before another refresh finished must not spend the new refresh token again.
    const current = text(tokens?.access_token);
    if (record && current && !isStale(record, current, now())) return current;
    if (!record || !tokens || !refreshToken) throw new Error("the Codex login has no refresh token");
    const answer = await postJson(
      options.tokenUrl ?? CODEX_TOKEN_URL,
      JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken }),
      options.ca,
    );
    if (answer.status !== 200) throw new Error(`the Codex token refresh was refused (HTTP ${answer.status})`);
    const issued = parseRecord(Buffer.from(answer.body));
    const accessToken = text(issued?.access_token);
    if (!issued || !accessToken) throw new Error("the Codex token refresh returned no access token");
    const updated: Json = {
      ...record,
      tokens: {
        ...tokens,
        access_token: accessToken,
        refresh_token: text(issued.refresh_token) ?? refreshToken,
        ...(text(issued.id_token) ? { id_token: issued.id_token } : {}),
      },
      last_refresh: new Date(now()).toISOString(),
    };
    await replaceRecord(file, updated);
    return accessToken;
  }

  return async () => {
    const record = parseRecord(await readRegularFile(file));
    if (!record) throw new Error("the Codex login is missing or unreadable");
    if (options.mode === "apikey") {
      const key = text(record.OPENAI_API_KEY);
      if (!key || tokensOf(record)) throw new Error("the Codex login is no longer an API key");
      return key;
    }
    const accessToken = text(tokensOf(record)?.access_token);
    if (!accessToken) throw new Error("the Codex login has no access token");
    if (!isStale(record, accessToken, now())) return accessToken;
    return serialized(file, refresh);
  };
}
