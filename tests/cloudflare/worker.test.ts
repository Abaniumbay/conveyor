import { expect, test } from "bun:test";
import { handleRequest } from "../../deploy/cloudflare/worker";

const origin = (response: Response) => async () => response;
const request = (method = "GET", accept = "text/html") => new Request("https://reports.number34.nl/board", { method, headers: { accept } });

test("passes healthy, authenticated, redirect, and application error responses through unchanged", async () => {
  for (const status of [200, 302, 401, 403, 404, 500]) {
    const response = new Response("origin", { status, headers: { "set-cookie": "session=test", location: "/login" } });
    expect(await handleRequest(request(), origin(response))).toBe(response);
  }
});

test("serves a standalone uncached recovery page on origin and Tunnel gateway errors", async () => {
  for (const status of [502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]) {
    const response = await handleRequest(request(), origin(new Response("gateway error", { status })));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("5");
    const html = await response.text();
    expect(html).toContain("We’ll be back shortly.");
    expect(html).toContain("/health/live");
    expect(html).not.toContain("gateway error");
    const nonce = /<script nonce="([^"]+)"/.exec(html)![1];
    expect(response.headers.get("content-security-policy")).toContain(`'nonce-${nonce}'`);
    expect(html).not.toContain("__NONCE__");
  }
});

test("never replaces API, asset, SSE, or mutation responses with the recovery page", async () => {
  for (const [method, accept] of [["GET", "application/json"], ["GET", "text/css"], ["GET", "text/event-stream"], ["POST", "text/html"]]) {
    const response = new Response("original error", { status: 502 });
    expect(await handleRequest(request(method, accept), origin(response))).toBe(response);
  }
});

test("handles thrown origin errors without retrying a mutation or leaking errors", async () => {
  let calls = 0;
  const failed = async () => { calls++; throw new Error("private origin details"); };
  const response = await handleRequest(request("POST"), failed);
  expect(calls).toBe(1);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "temporarily_unavailable" });
  const html = await handleRequest(request(), failed);
  expect(await html.text()).toContain("We’ll be back shortly.");
});

test("HEAD returns no page body and forwards the original request once", async () => {
  const req = request("HEAD");
  let calls = 0;
  const response = await handleRequest(req, (async (input) => {
    expect(input).toBe(req); calls++;
    return new Response(null, { status: 502 });
  }));
  expect(calls).toBe(1);
  expect(response.status).toBe(503);
  expect(await response.text()).toBe("");
});
