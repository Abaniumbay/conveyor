import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { startCredentialRelay } from "../../../src/isolation/credential-relay";
import type { EgressProxy } from "../../../src/isolation/egress-proxy";
import { claudeCredentials } from "../../../src/plugins/claude-code/launch";
import { REFRESH_MARGIN_MS } from "../../../src/plugins/claude-code/login-refresh";
import { FRESH, answerWith, startRefreshEndpoint, type RefreshAnswer, type RefreshCall, type RefreshEndpoint } from "../../support/refresh-endpoint";
import { startRelayUpstream, throwawayCertificate, type RelayUpstream } from "../../support/relay-upstream";
import { shortTemporaryDirectory } from "../../support/short-temporary-directory";

const PLACEHOLDER = "relay-placeholder";
let certificate: Awaited<ReturnType<typeof throwawayCertificate>>;
beforeAll(async () => {
  certificate = await throwawayCertificate();
});

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const oauth = (accessToken: string, expiresAt: number, extra: Record<string, unknown> = {}) => ({ accessToken, refreshToken: "refresh-1", expiresAt, scopes: ["user:inference"], subscriptionType: "max", ...extra });
const EXPIRED = () => oauth("expired-access", Date.now() - 60_000);

interface World {
  directory: string;
  file: string;
  upstream: RelayUpstream;
  refresh: RefreshEndpoint;
  /** Starts another relay (another run) for the same login. */
  relay(environment?: Record<string, string>): Promise<string>;
  send(socket: string): Promise<{ status: number; body: string }>;
  login(): Promise<{ claudeAiOauth: Record<string, unknown>; [key: string]: unknown }>;
  tokens(): Array<string | undefined>;
}

async function world(
  login: object | string | null,
  answer?: (call: RefreshCall, number: number) => RefreshAnswer | Promise<RefreshAnswer>,
  refreshUrl?: (endpoint: RefreshEndpoint) => string,
): Promise<World> {
  const directory = await shortTemporaryDirectory("conveyor-rf-", { socketPath: "relay-9.sock" });
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, "svc");
  await mkdir(config);
  const file = path.join(config, ".credentials.json");
  if (login !== null) await writeFile(file, typeof login === "string" ? login : JSON.stringify(login), { mode: 0o600 });
  const upstream = await startRelayUpstream(certificate);
  cleanups.push(() => upstream.close());
  const refresh = await startRefreshEndpoint(answer, certificate);
  cleanups.push(() => refresh.close());
  let count = 0;
  const relay = async (environment: Record<string, string> = {}): Promise<string> => {
    const socketPath = path.join(directory, `relay-${count++}.sock`);
    const credentials = claudeCredentials(environment, config, {
      upstream: `https://localhost:${upstream.port}`,
      ca: certificate.cert,
    }, { endpoint: refreshUrl ? refreshUrl(refresh) : refresh.url, ca: certificate.cert });
    const proxy: EgressProxy = await startCredentialRelay({ socketPath, placeholder: PLACEHOLDER, ...credentials.relay });
    cleanups.push(() => proxy.close());
    return socketPath;
  };
  const send = (socket: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request({ socketPath: socket, path: "/v1/messages", method: "POST", agent: false, headers: { authorization: `Bearer ${PLACEHOLDER}` } }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end("{}");
  });
  return {
    directory, file, upstream, refresh, relay, send,
    login: async () => JSON.parse(await readFile(file, "utf8")),
    tokens: () => upstream.requests.map((request) => request.headers.authorization as string | undefined),
  };
}

describe("a Claude Code login refreshed on the host", () => {
  test("AC-1.1: an expired login is refreshed and the refreshed token goes upstream", async () => {
    const w = await world({ claudeAiOauth: EXPIRED() });
    const reply = await w.send(await w.relay());
    expect(reply).toEqual({ status: 200, body: "upstream-ok" });
    expect(w.tokens()).toEqual(["Bearer fresh-access"]);
    expect(w.refresh.calls).toHaveLength(1);
    expect(w.refresh.calls[0]).toMatchObject({ method: "POST", body: { grant_type: "refresh_token", refresh_token: "refresh-1" } });
  });

  test("AC-2.1: a token inside the refresh margin is refreshed, one beyond it is not", async () => {
    const near = await world({ claudeAiOauth: oauth("near-expiry-access", Date.now() + REFRESH_MARGIN_MS - 1_000) });
    await near.send(await near.relay());
    expect(near.tokens()).toEqual(["Bearer fresh-access"]);
    expect(near.refresh.calls).toHaveLength(1);

    const beyond = await world({ claudeAiOauth: oauth("beyond-access", Date.now() + REFRESH_MARGIN_MS + 60_000) });
    await beyond.send(await beyond.relay());
    expect(beyond.tokens()).toEqual(["Bearer beyond-access"]);
    expect(beyond.refresh.calls).toHaveLength(0);
  });

  test("AC-3.1: a valid token is forwarded as is, with no refresh call and no write", async () => {
    const w = await world({ claudeAiOauth: oauth("valid-access", Date.now() + 3_600_000) });
    const before = await readFile(w.file);
    const socket = await w.relay();
    for (let index = 0; index < 3; index += 1) await w.send(socket);
    expect(w.tokens()).toEqual(Array(3).fill("Bearer valid-access"));
    expect(w.refresh.calls).toHaveLength(0);
    expect(Buffer.compare(await readFile(w.file), before)).toBe(0);
  });

  test("AC-4.1: the refreshed login keeps its other fields, its mode and leaves no temporary file", async () => {
    const w = await world({ claudeAiOauth: EXPIRED(), mcpOAuth: { srv: { token: "keep" } } });
    const original = (await w.login()).claudeAiOauth;
    await w.send(await w.relay());
    const after = await w.login();
    expect(after.claudeAiOauth).toMatchObject({ accessToken: "fresh-access", refreshToken: "refresh-2", scopes: ["user:inference"], subscriptionType: "max" });
    expect(Math.abs((after.claudeAiOauth.expiresAt as number) - (Date.now() + 28800 * 1000))).toBeLessThan(5_000);
    expect(after.claudeAiOauth.expiresAt).not.toBe(original.expiresAt);
    expect(after.mcpOAuth).toEqual({ srv: { token: "keep" } });
    expect((await stat(w.file)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(w.file))).toEqual([".credentials.json"]);
    // The replacement is staged beside the config directory, never inside the sandbox-visible one.
    expect((await readdir(w.directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("AC-8.1: a refused refresh token is sent to the endpoint once, not again on later requests", async () => {
    const w = await world({ claudeAiOauth: EXPIRED() }, () => ({ status: 400, body: "{}" }));
    const socket = await w.relay();
    const first = await w.send(socket);
    const second = await w.send(socket);
    const third = await w.send(await w.relay());
    expect([first.status, second.status, third.status].every((status) => status >= 500)).toBe(true);
    expect(w.refresh.calls).toHaveLength(1);
    expect(w.tokens()).toEqual([]);
    // A renewed login (a new refresh token) is tried again.
    await writeFile(w.file, JSON.stringify({ claudeAiOauth: oauth("renewed-access", Date.now() + 3_600_000, { refreshToken: "refresh-9" }) }), { mode: 0o600 });
    expect((await w.send(socket)).status).toBe(200);
    expect(w.tokens()).toEqual(["Bearer renewed-access"]);
  });

  test("AC-4.2: an answer without a refresh token keeps the stored one", async () => {
    const w = await world({ claudeAiOauth: EXPIRED() }, () => answerWith({ access_token: "fresh-access", expires_in: 3600 }));
    await w.send(await w.relay());
    const { claudeAiOauth } = await w.login();
    expect(claudeAiOauth).toMatchObject({ accessToken: "fresh-access", refreshToken: "refresh-1", subscriptionType: "max" });
    expect(Math.abs((claudeAiOauth.expiresAt as number) - (Date.now() + 3600 * 1000))).toBeLessThan(5_000);
  });

  test("AC-6.1: concurrent requests on an expired token refresh once and all use the refreshed token", async () => {
    const w = await world({ claudeAiOauth: EXPIRED() }, (_call, number) => (number === 1 ? answerWith(FRESH, 300) : { status: 400, body: "{}" }));
    const socket = await w.relay();
    const replies = await Promise.all(Array.from({ length: 8 }, () => w.send(socket)));
    expect(replies.map((reply) => reply.status)).toEqual(Array(8).fill(200));
    expect(w.refresh.calls).toHaveLength(1);
    expect(w.tokens()).toEqual(Array(8).fill("Bearer fresh-access"));
    expect((await w.login()).claudeAiOauth.refreshToken).toBe("refresh-2");
  });

  test("AC-6.2: two relays on the same login refresh it once", async () => {
    const w = await world({ claudeAiOauth: EXPIRED() }, (_call, number) => (number === 1 ? answerWith(FRESH, 300) : { status: 400, body: "{}" }));
    const [first, second] = [await w.relay(), await w.relay()];
    const replies = await Promise.all([w.send(first), w.send(second)]);
    expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
    expect(w.refresh.calls).toHaveLength(1);
    expect(w.tokens()).toEqual(["Bearer fresh-access", "Bearer fresh-access"]);
    expect((await w.login()).claudeAiOauth.refreshToken).toBe("refresh-2");
  });

  test("AC-6.3: a failed refresh is shared by the waiters and the next request tries again", async () => {
    const w = await world({ claudeAiOauth: EXPIRED() }, (_call, number) => (number === 1 ? { status: 503 } : answerWith(FRESH)));
    const socket = await w.relay();
    const failed = await Promise.all([w.send(socket), w.send(socket), w.send(socket)]);
    expect(failed.every((reply) => reply.status >= 500)).toBe(true);
    expect(w.upstream.requests).toEqual([]);
    expect((await w.send(socket)).status).toBe(200);
    expect(w.tokens()).toEqual(["Bearer fresh-access"]);
    expect(w.refresh.calls).toHaveLength(2);
    expect((await w.login()).claudeAiOauth).toMatchObject({ accessToken: "fresh-access", refreshToken: "refresh-2" });
  });

  describe("a newer login on disk", () => {
    const newer = () => ({ claudeAiOauth: oauth("newer-access", Date.now() + 8 * 3_600_000, { refreshToken: "newer-refresh" }) });

    test("AC-7.1: a refresh result never overwrites it and the newer token is forwarded", async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const w = await world({ claudeAiOauth: oauth("old-access", Date.now() - 60_000) }, async () => {
        await held;
        return answerWith({ access_token: "stale-result-access", refresh_token: "stale-result-refresh", expires_in: 28800 });
      });
      const socket = await w.relay();
      const first = w.send(socket);
      await w.refresh.received(1);
      await writeFile(w.file, JSON.stringify(newer()));
      release();
      expect((await first).status).toBe(200);
      expect((await w.login()).claudeAiOauth).toMatchObject({ accessToken: "newer-access", refreshToken: "newer-refresh" });
      expect((await w.send(socket)).status).toBe(200);
      expect(w.tokens()).toEqual(["Bearer newer-access", "Bearer newer-access"]);
      expect(w.refresh.calls).toHaveLength(1);
    });

    test("AC-7.2: a request arriving after the newer login is written uses it without a refresh", async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const w = await world({ claudeAiOauth: EXPIRED() }, async () => { await held; return answerWith(FRESH); });
      const socket = await w.relay();
      const first = w.send(socket);
      await w.refresh.received(1);
      await writeFile(w.file, JSON.stringify(newer()));
      const second = await w.send(socket);
      expect(second.status).toBe(200);
      expect(w.tokens()).toEqual(["Bearer newer-access"]);
      release();
      await first;
      expect((await w.login()).claudeAiOauth).toMatchObject({ accessToken: "newer-access" });
      expect(w.refresh.calls).toHaveLength(1);
    });
  });

  test("AC-9.2: a missing or malformed login file sends nothing upstream and calls no endpoint", async () => {
    for (const login of [null, "not json"]) {
      const w = await world(login);
      const reply = await w.send(await w.relay());
      expect(reply).toEqual({ status: 502, body: "credential unavailable" });
      expect(w.upstream.requests).toEqual([]);
      expect(w.refresh.calls).toHaveLength(0);
    }
  });

  test("AC-10.2: a connection reset by the refresh endpoint fails that request and the next one refreshes", async () => {
    const w = await world({ claudeAiOauth: EXPIRED() }, (_call, number) => (number === 1 ? { reset: true } : answerWith(FRESH)));
    const socket = await w.relay();
    const first = await w.send(socket);
    expect(first.status).toBeGreaterThanOrEqual(500);
    expect(w.upstream.requests).toEqual([]);
    expect((await w.send(socket)).status).toBe(200);
    expect(w.tokens()).toEqual(["Bearer fresh-access"]);
    expect(w.refresh.calls).toHaveLength(2);
    expect((await w.login()).claudeAiOauth.accessToken).toBe("fresh-access");
  });

  test("AC-12.2: with both environment credentials set the OAuth token wins and nothing refreshes", async () => {
    const w = await world({ claudeAiOauth: EXPIRED() });
    await w.send(await w.relay({ CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth-token", ANTHROPIC_API_KEY: "fixture-api-key" }));
    expect(w.tokens()).toEqual(["Bearer fixture-oauth-token"]);
    expect(w.refresh.calls).toHaveLength(0);
  });
});
