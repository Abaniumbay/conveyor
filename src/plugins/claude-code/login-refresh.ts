import { createHash, randomBytes } from "node:crypto";
import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";

/** Anthropic's OAuth token endpoint, where a `claude login` refresh token is exchanged. */
export const CLAUDE_REFRESH_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
/** The public OAuth client id Claude Code logs in with. */
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/** An access token expiring within this long is refreshed before it is used. */
export const REFRESH_MARGIN_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 30_000;

/** The login cannot be refreshed: it has no refresh token or the endpoint refused it. The operator must run `claude login`. */
export class LoginRenewalError extends Error {
  override readonly name = "LoginRenewalError";
  constructor() {
    super("the Claude Code login has expired and cannot be refreshed: renew it with `claude login`");
  }
}

/** The refresh failed for a reason a retry may fix (endpoint unreachable, reset, timed out or answered with a server error). */
export class LoginRefreshUnavailableError extends Error {
  override readonly name = "LoginRefreshUnavailableError";
  constructor(reason: string) {
    super(`the Claude Code login could not be refreshed: ${reason}`);
  }
}

interface Login {
  claudeAiOauth?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

export interface RefreshOptions {
  endpoint?: string | undefined;
  ca?: string | Buffer | undefined;
}

async function readLogin(file: string): Promise<{ login: Login; accessToken: string; refreshToken: string; expiresAt: number | null }> {
  const login = JSON.parse(await readFile(file, "utf8")) as Login;
  const oauth = login.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) throw new Error("the Claude Code login file holds no access token");
  return {
    login,
    accessToken: oauth.accessToken,
    refreshToken: typeof oauth.refreshToken === "string" ? oauth.refreshToken : "",
    expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null,
  };
}

/** A login without an expiry is used as is. */
const staleAfter = (expiresAt: number | null, margin: number): boolean => expiresAt !== null && expiresAt - Date.now() <= margin;

/** Exchanges the refresh token. Never puts a token or the endpoint's answer into an error. */
function exchange(refreshToken: string, options: RefreshOptions): Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number }> {
  const url = new URL(options.endpoint ?? CLAUDE_REFRESH_ENDPOINT);
  const body = JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE_OAUTH_CLIENT_ID });
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      agent: false,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      timeout: REFRESH_TIMEOUT_MS,
      ...(options.ca ? { ca: options.ca } : {}),
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", () => reject(new LoginRefreshUnavailableError("the refresh endpoint's answer was cut off")));
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        if (status === 400 || status === 401 || status === 403) return reject(new LoginRenewalError());
        if (status !== 200) return reject(new LoginRefreshUnavailableError(`the refresh endpoint answered ${status}`));
        try {
          const answer = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
          if (typeof answer.access_token !== "string" || !answer.access_token || typeof answer.expires_in !== "number") throw new Error("incomplete");
          resolve({ accessToken: answer.access_token, refreshToken: typeof answer.refresh_token === "string" && answer.refresh_token ? answer.refresh_token : null, expiresIn: answer.expires_in });
        } catch {
          reject(new LoginRefreshUnavailableError("the refresh endpoint's answer was not understood"));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", () => reject(new LoginRefreshUnavailableError("the refresh endpoint is unreachable")));
    request.end(body);
  });
}

/**
 * Replaces the file atomically, keeping its mode. The replacement is written beside the config
 * directory, not in it: the sandbox mounts that directory writable and could open a file there
 * before it is renamed.
 */
async function writeLogin(file: string, login: Login): Promise<void> {
  const { mode } = await stat(file);
  const temporary = path.join(path.dirname(path.dirname(file)), `.credentials.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(login), { mode: mode & 0o777 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

/** Runs `action` holding a host-wide lock on the login file (a lock file outside the sandbox's reach). */
async function withFileLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const lock = path.join(os.tmpdir(), `conveyor-claude-login-${createHash("sha256").update(file).digest("hex").slice(0, 16)}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await (await open(lock, "wx", 0o600)).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new LoginRefreshUnavailableError("the login lock could not be taken");
      const age = await stat(lock).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age > LOCK_STALE_MS) await rm(lock, { force: true });
      else if (Date.now() > deadline) throw new LoginRefreshUnavailableError("the login lock is held by another process");
      else await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await action();
  } finally {
    await rm(lock, { force: true });
  }
}

// One refresh per login file at a time, shared by every relay in this process; later callers join it.
const inFlight = new Map<string, Promise<string>>();
// The refresh token each login file last had refused, so it is not sent to the endpoint again.
const refused = new Map<string, string>();

async function refresh(file: string, options: RefreshOptions): Promise<string> {
  // Another refresh may have finished since the caller read the file.
  const start = await readLogin(file);
  if (!staleAfter(start.expiresAt, REFRESH_MARGIN_MS)) return start.accessToken;
  if (!start.refreshToken) {
    if (staleAfter(start.expiresAt, 0)) throw new LoginRenewalError();
    return start.accessToken;
  }
  if (refused.get(file) === start.refreshToken) {
    if (staleAfter(start.expiresAt, 0)) throw new LoginRenewalError();
    return start.accessToken;
  }
  let fresh: Awaited<ReturnType<typeof exchange>>;
  try {
    fresh = await exchange(start.refreshToken, options);
  } catch (error) {
    if (error instanceof LoginRenewalError) {
      refused.set(file, start.refreshToken);
      if (!staleAfter(start.expiresAt, 0)) return start.accessToken;
    }
    throw error;
  }
  refused.delete(file);
  // The check and the write happen under one lock: a newer login on disk is never overwritten.
  return withFileLock(file, async () => {
    const current = await readLogin(file);
    if (current.accessToken !== start.accessToken) return current.accessToken;
    const oauth = { ...current.login.claudeAiOauth, accessToken: fresh.accessToken, refreshToken: fresh.refreshToken ?? start.refreshToken, expiresAt: Date.now() + fresh.expiresIn * 1000 };
    await writeLogin(file, { ...current.login, claudeAiOauth: oauth });
    return fresh.accessToken;
  });
}

/**
 * The access token of the `claude login` file, refreshed on the host first when it expires within
 * `REFRESH_MARGIN_MS`. The file is read for every call. Concurrent callers share one refresh.
 */
export async function loginAccessToken(file: string, options: RefreshOptions = {}): Promise<string> {
  const current = await readLogin(file);
  if (!staleAfter(current.expiresAt, REFRESH_MARGIN_MS)) return current.accessToken;
  const running = inFlight.get(file);
  if (running) return running;
  const started = refresh(file, options).finally(() => inFlight.delete(file));
  inFlight.set(file, started);
  return started;
}
