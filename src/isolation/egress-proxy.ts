import { createHash, timingSafeEqual } from "node:crypto";
import dns from "node:dns/promises";
import { rm } from "node:fs/promises";
import net from "node:net";

export interface EgressProxyOptions {
  socketPath: string;
  /** Exact lowercase DNS names that may be reached on port 443. */
  allowedHosts: readonly string[];
  /** When set, every request must carry `Proxy-Authorization: Basic base64(<user>:<token>)`. */
  token?: string;
  /** Resolves a host to its addresses; injectable for tests. */
  resolve?: (host: string) => Promise<string[]>;
  /** Opens the upstream connection to an already-validated address; injectable for tests. */
  dial?: (address: string, port: number) => net.Socket;
  /** Called for every refused CONNECT (operator diagnostics; never carries credentials). */
  onDeny?: (target: string, reason: string) => void;
}

export interface EgressProxy {
  socketPath: string;
  close(): Promise<void>;
}

const MAX_HEAD_BYTES = 16 * 1024;

function ipv4Blocked(address: string): boolean {
  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** True for loopback, private, link-local, CGNAT, ULA, multicast and unspecified addresses. */
export function isNonPublicAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) return ipv4Blocked(address);
  if (version !== 6) return true;
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return ipv4Blocked(mapped[1]!);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(lower)) return true;
  const first = parseInt(lower.split(":")[0] || "0", 16);
  return (
    lower === "::" || lower === "::1" ||
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link local
    (first & 0xff00) === 0xff00 || // multicast
    lower.startsWith("64:ff9b:") // NAT64 can embed private v4
  );
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const match = /^Basic\s+(\S+)$/i.exec(header ?? "");
  if (!match) return false;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const supplied = decoded.slice(decoded.indexOf(":") + 1);
  return timingSafeEqual(digest(supplied), digest(token));
}

function reply(socket: net.Socket, status: number, reason: string, extra = ""): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
}

/**
 * Starts an allowlist CONNECT proxy on a Unix socket. Only `CONNECT <allowed host>:443` is served:
 * the target must be a listed DNS name (never an IP literal), is resolved here, and is refused if
 * any answer is non-public. Each CONNECT is validated independently, so redirects are covered.
 */
export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const allowed = new Set(options.allowedHosts);
  const resolve = options.resolve ?? (async (host) => (await dns.lookup(host, { all: true })).map((entry) => entry.address));
  const dial = options.dial ?? ((address: string, port: number) => net.connect({ host: address, port }));
  const sockets = new Set<net.Socket>();

  async function handle(client: net.Socket, head: string, rest: Buffer): Promise<void> {
    const lines = head.split("\r\n");
    const headers = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    if (options.token !== undefined && !tokenMatches(headers.get("proxy-authorization"), options.token)) {
      return reply(client, 407, "Proxy Authentication Required", 'Proxy-Authenticate: Basic realm="conveyor"\r\n');
    }
    const [method, target] = (lines[0] ?? "").split(" ");
    const deny = (what: string, reason: string): void => {
      options.onDeny?.(what, reason);
      reply(client, 403, "Forbidden");
    };
    if (method !== "CONNECT" || !target) return deny(`${method ?? ""} request`, "only CONNECT is supported");
    const separator = target.lastIndexOf(":");
    const host = separator > 0 ? target.slice(0, separator) : "";
    if (separator < 0 || target.slice(separator + 1) !== "443") return deny(target, "only port 443 is allowed");
    if (net.isIP(host) || host.startsWith("[")) return deny(target, "IP-literal targets are not allowed");
    if (!allowed.has(host)) return deny(target, "host is not in the allowlist");

    let addresses: string[];
    try {
      addresses = await resolve(host);
    } catch {
      return reply(client, 502, "Bad Gateway");
    }
    if (addresses.length === 0) return reply(client, 502, "Bad Gateway");
    if (addresses.some(isNonPublicAddress)) return deny(target, `resolves to a non-public address (${addresses.join(", ")})`);

    const upstream = dial(addresses[0]!, 443);
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    let connected = false;
    upstream.once("error", () => {
      if (connected) client.destroy();
      else reply(client, 502, "Bad Gateway");
    });
    upstream.once("connect", () => {
      connected = true;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length > 0) upstream.write(rest);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  }

  const server = net.createServer((client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffered.length > MAX_HEAD_BYTES) reply(client, 431, "Request Header Fields Too Large");
        return;
      }
      client.off("data", onData);
      client.pause();
      void handle(client, buffered.subarray(0, end).toString("latin1"), buffered.subarray(end + 4))
        .then(() => client.resume())
        .catch(() => client.destroy());
    };
    client.on("data", onData);
  });

  await rm(options.socketPath, { force: true });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, resolveListen);
  });
  return {
    socketPath: options.socketPath,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(options.socketPath, { force: true });
    },
  };
}
