import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { codexCredentialSource } from "../../../src/plugins/codex/credential-source";
import { chatgptRecord, fixtureJwt, HOUR, secondsFromNow, writeLogin } from "../../support/codex-login";
import { startRelayUpstream, throwawayCertificate, type RelayUpstream } from "../../support/relay-upstream";

const directories: string[] = [];
const servers: RelayUpstream[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-codex-source-"));
  directories.push(directory);
  return directory;
}

async function endpoint(answer: (body: string, count: number) => { status: number; body: string; delayMs?: number }) {
  let count = 0;
  const server = await startRelayUpstream(await throwawayCertificate(), (body) => answer(body, ++count));
  servers.push(server);
  return { server, tokenUrl: `https://localhost:${server.port}/oauth/token`, ca: server.cert };
}

const issued = (access: string, refresh: string) => JSON.stringify({ access_token: access, refresh_token: refresh, id_token: fixtureJwt({ exp: secondsFromNow(HOUR) }) });

describe("codexCredentialSource", () => {
  test("reads the record on every call so a rotated credential applies at once (AC-3.3)", async () => {
    const serviceHome = await home();
    await writeLogin(serviceHome, chatgptRecord("ACCESS-A"));
    const source = codexCredentialSource({ serviceHome, mode: "chatgpt" });
    const first = await source();
    await writeLogin(serviceHome, chatgptRecord("ACCESS-B"));
    const second = await source();
    expect(JSON.parse(Buffer.from(first.split(".")[1]!, "base64url").toString()).marker).toBe("ACCESS-A");
    expect(JSON.parse(Buffer.from(second.split(".")[1]!, "base64url").toString()).marker).toBe("ACCESS-B");

    await writeLogin(serviceHome, { auth_mode: "apikey", OPENAI_API_KEY: "sk-fixture-REAL-KEY-1" });
    expect(await codexCredentialSource({ serviceHome, mode: "apikey" })()).toBe("sk-fixture-REAL-KEY-1");
  });

  test("fails closed for a missing, malformed, symlinked, mismatched or empty record (AC-3.3)", async () => {
    const serviceHome = await home();
    const chatgpt = codexCredentialSource({ serviceHome, mode: "chatgpt" });
    await expect(chatgpt()).rejects.toThrow();
    await writeLogin(serviceHome, "not json");
    await expect(chatgpt()).rejects.toThrow();
    await writeLogin(serviceHome, { auth_mode: "chatgpt", tokens: {} });
    await expect(chatgpt()).rejects.toThrow();
    await writeLogin(serviceHome, { auth_mode: "apikey", OPENAI_API_KEY: "sk-fixture-REAL-KEY-1" });
    await expect(chatgpt()).rejects.toThrow();
    await writeLogin(serviceHome, chatgptRecord("ACCESS-A"));
    await expect(codexCredentialSource({ serviceHome, mode: "apikey" })()).rejects.toThrow();

    const other = await home();
    const real = await writeLogin(other, chatgptRecord("ACCESS-A"));
    await rm(path.join(serviceHome, "auth.json"));
    await symlink(real, path.join(serviceHome, "auth.json"));
    await expect(chatgpt()).rejects.toThrow("missing or unreadable");
  });

  test("refreshes an expired access token once and persists the record atomically (AC-4.1)", async () => {
    const serviceHome = await home();
    const record = chatgptRecord("ACCESS-OLD", { expiresIn: -HOUR });
    await writeLogin(serviceHome, { ...record, extra: "kept" });
    const newAccess = fixtureJwt({ exp: secondsFromNow(HOUR), marker: "ACCESS-NEW" });
    const { server, tokenUrl, ca } = await endpoint(() => ({ status: 200, body: issued(newAccess, "REAL-REFRESH-2") }));
    const source = codexCredentialSource({ serviceHome, mode: "chatgpt", tokenUrl, ca });

    expect(await source()).toBe(newAccess);
    expect(await source()).toBe(newAccess);

    const posts = server.requests.filter((request) => request.url === "/oauth/token");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.method).toBe("POST");
    const sent = JSON.parse(posts[0]!.body);
    expect(sent).toMatchObject({ grant_type: "refresh_token", refresh_token: "REAL-REFRESH-1", client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
    const saved = JSON.parse(await readFile(path.join(serviceHome, "auth.json"), "utf8"));
    expect(saved.tokens.access_token).toBe(newAccess);
    expect(saved.tokens.refresh_token).toBe("REAL-REFRESH-2");
    expect(saved.tokens.account_id).toBe("acct-fixture");
    expect(saved.extra).toBe("kept");
    expect(saved.OPENAI_API_KEY).toBeNull();
    expect(Date.now() - Date.parse(saved.last_refresh)).toBeLessThan(60_000);
    expect((await stat(path.join(serviceHome, "auth.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(serviceHome)).toEqual(["auth.json"]);
  });

  test("concurrent requests with an expired token cause one refresh (AC-4.3)", async () => {
    const serviceHome = await home();
    await writeLogin(serviceHome, chatgptRecord("ACCESS-OLD", { expiresIn: -HOUR }));
    const newAccess = fixtureJwt({ exp: secondsFromNow(HOUR), marker: "ACCESS-NEW" });
    const { server, tokenUrl, ca } = await endpoint((_body, count) => count === 1
      ? { status: 200, body: issued(newAccess, "REAL-REFRESH-2"), delayMs: 200 }
      : { status: 400, body: '{"error":"invalid_grant"}' });
    const source = codexCredentialSource({ serviceHome, mode: "chatgpt", tokenUrl, ca });

    const results = await Promise.all([source(), source(), source(), source()]);
    expect(results).toEqual([newAccess, newAccess, newAccess, newAccess]);
    expect(server.requests.filter((request) => request.url === "/oauth/token")).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(serviceHome, "auth.json"), "utf8")).tokens.refresh_token).toBe("REAL-REFRESH-2");
  });

  test("separate sources of one login (concurrent runs) share one refresh (AC-4.3)", async () => {
    const serviceHome = await home();
    await writeLogin(serviceHome, chatgptRecord("ACCESS-OLD", { expiresIn: -HOUR }));
    const newAccess = fixtureJwt({ exp: secondsFromNow(HOUR), marker: "ACCESS-NEW" });
    const { server, tokenUrl, ca } = await endpoint((_body, count) => count === 1
      ? { status: 200, body: issued(newAccess, "REAL-REFRESH-2"), delayMs: 200 }
      : { status: 400, body: '{"error":"invalid_grant"}' });
    const sources = [1, 2, 3].map(() => codexCredentialSource({ serviceHome, mode: "chatgpt", tokenUrl, ca }));

    const results = await Promise.all(sources.map((source) => source()));
    expect(results).toEqual([newAccess, newAccess, newAccess]);
    expect(server.requests.filter((request) => request.url === "/oauth/token")).toHaveLength(1);
  });

  test("a failed refresh leaves the record untouched, leaks nothing and recovers later (AC-4.4, AC-2.4)", async () => {
    const serviceHome = await home();
    const file = await writeLogin(serviceHome, chatgptRecord("ACCESS-OLD", { expiresIn: -HOUR }));
    const before = await readFile(file);
    const newAccess = fixtureJwt({ exp: secondsFromNow(HOUR), marker: "ACCESS-NEW" });
    let mode: "invalid" | "error" | "malformed" | "ok" = "invalid";
    const { tokenUrl, ca } = await endpoint((body) => {
      if (mode === "invalid") return { status: 400, body: JSON.stringify({ error: "invalid_grant", echoed: JSON.parse(body).refresh_token }) };
      if (mode === "error") return { status: 500, body: "boom" };
      if (mode === "malformed") return { status: 200, body: "{not json" };
      return { status: 200, body: issued(newAccess, "REAL-REFRESH-2") };
    });
    const source = codexCredentialSource({ serviceHome, mode: "chatgpt", tokenUrl, ca });
    for (const failing of ["invalid", "error", "malformed"] as const) {
      mode = failing;
      const error = await source().then(() => undefined, (caught: Error) => caught);
      expect(error).toBeDefined();
      expect(error!.message).not.toContain("REAL-REFRESH-1");
      expect(await readFile(file)).toEqual(before);
    }
    const refused = codexCredentialSource({ serviceHome, mode: "chatgpt", tokenUrl: "https://localhost:1/oauth/token", ca });
    await expect(refused()).rejects.toThrow();
    expect(await readFile(file)).toEqual(before);

    mode = "ok";
    expect(await source()).toBe(newAccess);
  });

  test("an access token that is not a JWT is refreshed only when the login is old", async () => {
    const serviceHome = await home();
    const record = chatgptRecord("x");
    (record.tokens as Record<string, unknown>).access_token = "opaque-token";
    await writeLogin(serviceHome, record);
    expect(await codexCredentialSource({ serviceHome, mode: "chatgpt" })()).toBe("opaque-token");
    await writeFile(path.join(serviceHome, "auth.json"), JSON.stringify({ ...record, last_refresh: new Date(Date.now() - 9 * 24 * 3600_000).toISOString() }));
    await expect(codexCredentialSource({ serviceHome, mode: "chatgpt", tokenUrl: "https://localhost:1/oauth/token" })()).rejects.toThrow();
  });
});
