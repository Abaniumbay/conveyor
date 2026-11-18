import { createHash, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";

import type { EgressProxy } from "./egress-proxy";

export interface CredentialRelayOptions {
  /** Unix socket the relay listens on; the sandbox bridge forwards a loopback port to it. */
  socketPath: string;
  /** HTTPS base URL every request is forwarded under (for example `https://api.example.com/v1`). */
  upstream: string;
  /** Returns the real credential; called on the host for every forwarded request, never cached. */
  credential: () => string | Promise<string>;
  /** The only credential a request may carry; the relay substitutes the real one. */
  placeholder: string;
  /** Header the real credential is sent in: `Authorization: Bearer` (default) or `x-api-key` for an API key. */
  credentialHeader?: "authorization" | "x-api-key";
  /** Extra trust anchor for the upstream certificate; injectable for tests. Verification is always on. */
  ca?: string | Buffer;
}

const UPSTREAM_IDLE_TIMEOUT_MS = 5 * 60_000;
// Headers that belong to one connection, plus credentials the sandbox must not smuggle upstream.
const DROPPED_REQUEST_HEADERS = new Set([
  "host", "authorization", "proxy-authorization", "x-api-key", "api-key", "x-goog-api-key", "cookie",
  "connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);
const DROPPED_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "set-cookie"]);

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function presentsPlaceholder(header: string | undefined, placeholder: string): boolean {
  const match = /^Bearer (\S+)$/.exec(header ?? "");
  return match !== null && timingSafeEqual(digest(match[1]!), digest(placeholder));
}

function hasDotSegment(rawPath: string): boolean {
  if (/%(?:2f|5c)/i.test(rawPath) || rawPath.includes("\\")) return true;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return true;
  }
  return decoded.split("/").some((segment) => segment === "." || segment === "..");
}

function respond(response: http.ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(body), Connection: "close" });
  response.end(body);
}

/**
 * Starts a relay on a Unix socket that forwards HTTP requests to one HTTPS upstream, replacing the
 * run's placeholder credential with the real one read from `credential` on the host. Any other
 * credential is refused; the upstream host, scheme and base path never come from the request.
 */
export async function startCredentialRelay(options: CredentialRelayOptions): Promise<EgressProxy> {
  let base: URL;
  try {
    base = new URL(options.upstream);
  } catch {
    throw new Error(`credential relay upstream "${options.upstream}" is not a valid URL`);
  }
  if (base.protocol !== "https:") throw new Error(`credential relay upstream ${base.protocol}//${base.host}${base.pathname} must use https`);
  const basePath = base.pathname.replace(/\/+$/, "");
  const connections = new Set<{ destroy(): unknown }>();

  async function forward(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const target = request.url ?? "";
    if (!presentsPlaceholder(request.headers.authorization, options.placeholder)) return respond(response, 401, "unauthorized");
    const [rawPath = "", ...query] = target.split("?");
    if (!target.startsWith("/") || target.startsWith("//") || hasDotSegment(rawPath)) return respond(response, 400, "bad request");
    let credential: string;
    try {
      credential = await options.credential();
    } catch {
      return respond(response, 502, "credential unavailable");
    }
    if (!credential) return respond(response, 502, "credential unavailable");

    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (!DROPPED_REQUEST_HEADERS.has(name)) headers[name] = value;
    }
    if (options.credentialHeader === "x-api-key") headers["x-api-key"] = credential;
    else headers.authorization = `Bearer ${credential}`;
    const upstream = https.request({
      host: base.hostname,
      port: base.port || 443,
      path: `${basePath}${rawPath}${query.length > 0 ? `?${query.join("?")}` : ""}`,
      method: request.method,
      headers,
      agent: false,
      ...(options.ca ? { ca: options.ca } : {}),
    });
    connections.add(upstream);
    upstream.once("close", () => connections.delete(upstream));
    upstream.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => upstream.destroy());
    upstream.once("error", () => {
      if (response.headersSent) response.destroy();
      else respond(response, 502, "bad gateway");
    });
    upstream.once("response", (answer) => {
      const outgoing: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(answer.headers)) {
        if (!DROPPED_RESPONSE_HEADERS.has(name)) outgoing[name] = value;
      }
      response.writeHead(answer.statusCode ?? 502, outgoing);
      answer.pipe(response);
      answer.once("error", () => response.destroy());
    });
    response.once("close", () => upstream.destroy());
    request.pipe(upstream);
  }

  const server = http.createServer((request, response) => {
    forward(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else respond(response, 502, "bad gateway");
    });
  });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  // The relay is not a proxy: CONNECT and upgrades are refused.
  server.on("connect", (_request, socket) => {
    socket.end("HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  await rm(options.socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, resolve);
  });
  return {
    socketPath: options.socketPath,
    async close() {
      for (const connection of connections) connection.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(options.socketPath, { force: true });
    },
  };
}
