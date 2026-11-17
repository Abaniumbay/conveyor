import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import type net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

export interface RecordedRequest {
  method: string;
  url: string;
  host: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface RelayUpstream {
  port: number;
  /** PEM of the throwaway certificate, to hand to the relay as its trust anchor. */
  cert: string;
  requests: RecordedRequest[];
  /** Number of TCP connections the server has accepted (counts refused TLS handshakes too). */
  connections: () => number;
  /** Number of in-flight sockets still open. */
  open: () => number;
  close(): Promise<void>;
}

/** Generates a throwaway self-signed certificate for `localhost`; nothing is committed or kept. */
export async function throwawayCertificate(): Promise<{ cert: string; key: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-cert-"));
  try {
    const keyFile = path.join(directory, "key.pem");
    const certFile = path.join(directory, "cert.pem");
    // A private config keeps the host's openssl.cnf (possibly absent) out of the picture.
    const configFile = path.join(directory, "openssl.cnf");
    await writeFile(configFile, "[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = localhost\n");
    const result = Bun.spawnSync([
      "openssl", "req", "-config", configFile, "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
    ], { stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`openssl failed: ${result.stderr.toString()}`);
    return { cert: await readFile(certFile, "utf8"), key: await readFile(keyFile, "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * A loopback TLS server standing in for the relay's upstream. It records every request on the host and
 * never echoes request headers. `/v1/stream` answers in two chunks, `/v1/error` answers 500 and
 * `/v1/slow` holds its response open.
 */
export async function startRelayUpstream(certificate?: { cert: string; key: string }): Promise<RelayUpstream> {
  const { cert, key } = certificate ?? (await throwawayCertificate());
  const requests: RecordedRequest[] = [];
  const sockets = new Set<net.Socket>();
  let accepted = 0;
  const server = https.createServer({ cert, key }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        host: request.headers.host,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const route = (request.url ?? "").split("?")[0];
      if (route === "/v1/slow") return;
      if (route === "/v1/error") {
        response.writeHead(500);
        response.end("upstream-failed");
        return;
      }
      if (route === "/v1/stream") {
        response.writeHead(200);
        response.write("chunk-one;");
        setTimeout(() => response.end("chunk-two"), 50);
        return;
      }
      response.writeHead(200);
      response.end("upstream-ok");
    });
  });
  server.on("connection", (socket) => {
    accepted += 1;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    cert,
    requests,
    connections: () => accepted,
    open: () => sockets.size,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
