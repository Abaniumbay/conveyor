import { afterEach, describe, expect, test } from "bun:test";
import { readdir, rm } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { startCredentialRelay, type CredentialRelayOptions } from "../../src/isolation/credential-relay";
import { MAX_SOCKET_PATH, startRunNetwork } from "../../src/isolation/run-network";
import { shortTemporaryDirectory } from "../support/short-temporary-directory";
import { startRelayUpstream, throwawayCertificate, type RelayUpstream } from "../support/relay-upstream";

const PLACEHOLDER = "placeholder-for-this-run-0123456789abcdef";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function directory(): Promise<string> {
  const dir = await shortTemporaryDirectory("conveyor-relay-", { socketPath: "relay.sock" });
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function upstream(certificate?: Awaited<ReturnType<typeof throwawayCertificate>>): Promise<RelayUpstream> {
  const server = await startRelayUpstream(certificate);
  cleanups.push(() => server.close());
  return server;
}

async function relay(dir: string, options: Partial<CredentialRelayOptions> & Pick<CredentialRelayOptions, "upstream">) {
  const started = await startCredentialRelay({ socketPath: path.join(dir, "relay.sock"), credential: () => "real-secret-1", placeholder: PLACEHOLDER, ...options });
  cleanups.push(() => started.close());
  return started;
}

function send(socketPath: string, requestPath: string, headers: Record<string, string> = { authorization: `Bearer ${PLACEHOLDER}` }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: requestPath, method: "GET", headers }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

describe("credential relay over a real socket", () => {
  test("an upstream certificate outside the relay's trust gets 502 and no request or credential reaches it", async () => {
    const dir = await directory();
    const untrusted = await upstream();
    const other = await throwawayCertificate();
    const started = await relay(dir, { upstream: `https://localhost:${untrusted.port}/v1`, ca: other.cert });
    const answer = await send(started.socketPath, "/models");
    expect(answer.status).toBe(502);
    expect(untrusted.requests).toEqual([]);
  });

  test("an http:// upstream base URL is refused by name and leaves no socket behind", async () => {
    const dir = await directory();
    await expect(startCredentialRelay({
      socketPath: path.join(dir, "relay.sock"), upstream: "http://localhost:9/v1", credential: () => "x", placeholder: PLACEHOLDER,
    })).rejects.toThrow("http://localhost:9/v1");
    expect(await readdir(dir)).toEqual([]);
  });

  test.each([
    ["throws", () => { throw new Error("vault down: real-secret-1"); }],
    ["returns an empty string", () => ""],
  ])("a credential source that %s is not forwarded and leaks nothing, and the relay recovers", async (_name, failing) => {
    const dir = await directory();
    const server = await upstream();
    let source: () => string = failing;
    const started = await relay(dir, { upstream: `https://localhost:${server.port}/v1`, ca: server.cert, credential: () => source() });
    const failed = await send(started.socketPath, "/models");
    expect([502, 503]).toContain(failed.status);
    expect(failed.body).not.toContain("real-secret-1");
    expect(failed.body).not.toContain("vault");
    expect(server.requests).toEqual([]);
    source = () => "real-secret-1";
    expect((await send(started.socketPath, "/models")).status).toBe(200);
    expect(server.requests[0]?.headers.authorization).toBe("Bearer real-secret-1");
  });

  test("closing the relay aborts a request in flight and drops the upstream connection", async () => {
    const dir = await directory();
    const server = await upstream();
    const started = await relay(dir, { upstream: `https://localhost:${server.port}/v1`, ca: server.cert });
    const pending = send(started.socketPath, "/slow").then(() => "answered", () => "destroyed");
    const deadline = Date.now() + 5000;
    while (server.requests.length === 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(server.requests).toHaveLength(1);
    const begun = Date.now();
    await started.close();
    expect(Date.now() - begun).toBeLessThan(2000);
    expect(await pending).toBe("destroyed");
    const settled = Date.now() + 2000;
    while (server.open() > 0 && Date.now() < settled) await Bun.sleep(20);
    expect(server.open()).toBe(0);
  });
});

describe("startRunNetwork with a relay that cannot start", () => {
  test("a socket path that is too long is refused and nothing is left behind", async () => {
    const dir = await directory();
    const long = path.join(dir, "x".repeat(MAX_SOCKET_PATH));
    await expect(startRunNetwork({
      directory: long,
      policy: { httpsHosts: [], controlPlaneHosts: [], relay: { upstream: "https://localhost:1/v1", credential: () => "x" } },
    })).rejects.toThrow("longer than");
    expect(await readdir(dir)).toEqual([]);
  });

  test.each(["not a url", "http://localhost:9/v1"])("the upstream %p is refused, earlier proxies are closed and no socket file remains", async (bad) => {
    const dir = await directory();
    const run = path.join(dir, "n");
    await expect(startRunNetwork({
      directory: run,
      policy: { httpsHosts: [], controlPlaneHosts: [], relay: { upstream: bad, credential: () => "x" } },
    })).rejects.toThrow(bad);
    expect((await readdir(run)).filter((name) => name.endsWith(".sock"))).toEqual([]);
  });
});
