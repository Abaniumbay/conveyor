import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

import { createOperatorMcpHandler, OPERATOR_MCP_PATH } from "../../src/operator-mcp/server";
import { defineOperatorTool, type OperatorReadStore } from "../../src/operator-mcp/tool";
import { OPERATOR_TOOLS } from "../../src/operator-mcp/registry";
import { hashOperatorToken, newOperatorToken } from "../../src/operator-mcp/tokens";
import { createWebAuth, hashPassword } from "../../src/web/auth";
import { createWebHandler } from "../../src/web/server";

const STATUS = { ready: true, draining: false, openQuestions: 2 };
const active = new Set<string>();
const stops: Array<() => void> = [];
afterEach(() => {
  active.clear();
  for (const stop of stops.splice(0)) stop();
});

function facade(store: OperatorReadStore = {} as OperatorReadStore) {
  return { store, status: () => STATUS, findItem: () => null, dispatch: () => { throw new Error("no commands in this test"); } };
}

function listen(handler: (request: Request) => Promise<Response>): string {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  stops.push(() => void server.stop(true));
  return server.url.href;
}

const call = (url: string, authorization: string | null, name: string) => fetch(new URL(OPERATOR_MCP_PATH, url), {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(authorization === null ? {} : { authorization }) },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
});

describe("operator MCP endpoint", () => {
  test("the registry ships conveyor_status", () => {
    expect(OPERATOR_TOOLS.map((tool) => tool.name)).toContain("conveyor_status");
  });

  test("a valid token lists tools and calls conveyor_status over real HTTP", async () => {
    const token = newOperatorToken();
    const url = listen(createOperatorMcpHandler({ facade: facade(), tokenIsActive: (hash) => hash === hashOperatorToken(token) }));
    const client = new Client({ name: "test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(OPERATOR_MCP_PATH, url), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
    // The SDK's class declares an optional sessionId that exactOptionalPropertyTypes rejects for Transport.
    await client.connect(transport as Parameters<Client["connect"]>[0]);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("conveyor_status");
      const result = await client.callTool({ name: "conveyor_status", arguments: {} });
      expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual(STATUS);
    } finally {
      await client.close();
    }
  });

  test("no Authorization header gets 401 and runs no tool", async () => {
    let runs = 0;
    const tool = defineOperatorTool({ name: "spy", description: "spy", inputSchema: z.object({}), handler: () => { runs += 1; return {}; } });
    const url = listen(createOperatorMcpHandler({ facade: facade(), tokenIsActive: () => true, tools: [tool] }));
    expect((await call(url, null, "spy")).status).toBe(401);
    expect(runs).toBe(0);
  });

  test("unknown, malformed and revoked bearer tokens get 401 and run no tool", async () => {
    let runs = 0;
    const tool = defineOperatorTool({ name: "spy", description: "spy", inputSchema: z.object({}), handler: () => { runs += 1; return {}; } });
    const known = newOperatorToken();
    const revoked = new Set<string>();
    const url = listen(createOperatorMcpHandler({
      facade: facade(),
      tokenIsActive: (hash) => hash === hashOperatorToken(known) && !revoked.has(hash),
      tools: [tool],
    }));
    expect((await call(url, `Bearer ${newOperatorToken()}`, "spy")).status).toBe(401);
    expect((await call(url, "Bearer not a token!", "spy")).status).toBe(401);
    expect((await call(url, `Basic ${known}`, "spy")).status).toBe(401);
    expect((await call(url, "Bearer ", "spy")).status).toBe(401);
    expect(runs).toBe(0);
    expect((await call(url, `Bearer ${known}`, "spy")).status).toBe(200);
    expect(runs).toBe(1);
    revoked.add(hashOperatorToken(known));
    expect((await call(url, `Bearer ${known}`, "spy")).status).toBe(401);
    expect(runs).toBe(1);
  });

  test("no route outside the MCP endpoint dispatches an operator tool", async () => {
    let runs = 0;
    const tool = defineOperatorTool({ name: "spy", description: "spy", inputSchema: z.object({}), handler: () => { runs += 1; return {}; } });
    const token = newOperatorToken();
    const handleOperatorMcp = createOperatorMcpHandler({ facade: facade(), tokenIsActive: () => true, tools: [tool] });
    const handler = createWebHandler({
      auth: createWebAuth({ passwordHash: hashPassword("correct horse", { salt: "0123456789abcdef" }), sessionSecret: "session-secret-that-is-at-least-thirty-two-bytes", secureCookies: false }),
      username: "operator",
      isReady: () => true,
      webhookPath: "/hooks/custom",
      handleWebhook: async () => {},
      handleMcp: async () => ({ ok: true }),
      handleOperatorMcp,
    } as never);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "spy", arguments: {} } });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` };
    for (const route of ["/", "/internal/mcp", "/mcp", "/operator-mcp/", "/v1/status", "/api/operator-mcp", "/hooks/custom", "/app", "/login", "/questions/1/answer"]) {
      await handler(new Request(new URL(route, "http://localhost"), { method: "POST", headers, body }));
    }
    expect(runs).toBe(0);
    expect((await handler(new Request(new URL(OPERATOR_MCP_PATH, "http://localhost"), { method: "POST", headers, body }))).status).toBe(200);
    expect(runs).toBe(1);
  });
});
