import https from "node:https";
import type net from "node:net";

import { throwawayCertificate } from "./relay-upstream";

export interface RefreshCall {
  method: string;
  url: string;
  /** The parsed JSON body, or the raw text when it is not JSON. */
  body: Record<string, unknown>;
}

export type RefreshAnswer = { status: number; body?: string; delayMs?: number } | { reset: true };

export interface RefreshEndpoint {
  /** `https://localhost:<port>/v1/oauth/token`, for the relay's refresh seam. */
  url: string;
  /** PEM trust anchor for `url`. */
  cert: string;
  calls: RefreshCall[];
  /** Resolves once `count` calls have arrived. */
  received(count: number): Promise<void>;
  close(): Promise<void>;
}

export const FRESH = { access_token: "fresh-access", refresh_token: "refresh-2", expires_in: 28800 };
export const answerWith = (body: object, delayMs = 0): RefreshAnswer => ({ status: 200, body: JSON.stringify(body), delayMs });

/**
 * A loopback TLS server standing in for the OAuth token endpoint. `answer` decides each call's reply
 * (the 1-based call number is passed); the default accepts every call with `FRESH`.
 */
export async function startRefreshEndpoint(
  answer: (call: RefreshCall, number: number) => RefreshAnswer | Promise<RefreshAnswer> = () => answerWith(FRESH),
  certificate?: { cert: string; key: string },
): Promise<RefreshEndpoint> {
  const { cert, key } = certificate ?? (await throwawayCertificate());
  const calls: RefreshCall[] = [];
  const sockets = new Set<net.Socket>();
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const server = https.createServer({ cert, key }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown>;
      try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { raw: text }; }
      const call = { method: request.method ?? "", url: request.url ?? "", body };
      calls.push(call);
      for (const waiter of waiters.filter((entry) => calls.length >= entry.count)) waiter.resolve();
      const reply = await answer(call, calls.length);
      if ("reset" in reply) return request.socket.destroy();
      if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(reply.body ?? "{}");
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `https://localhost:${port}/v1/oauth/token`,
    cert,
    calls,
    received: (count) => (calls.length >= count ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ count, resolve }))),
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
