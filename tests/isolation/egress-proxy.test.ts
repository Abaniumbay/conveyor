import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { startEgressProxy, type EgressProxy } from "../../src/isolation/egress-proxy";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function socketPath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "egress-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "p.sock");
}

/** A local TCP server that answers "pong:<line>" to every line, standing in for an allowed host. */
async function echoServer(): Promise<number> {
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => socket.write(`pong:${chunk}`));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as net.AddressInfo).port;
}

function request(socket: string, head: string): Promise<{ status: number; raw: string; connection: net.Socket }> {
  return new Promise((resolve, reject) => {
    const connection = net.connect(socket);
    let raw = "";
    connection.on("error", reject);
    connection.on("data", (chunk) => {
      raw += chunk.toString();
      const end = raw.indexOf("\r\n");
      if (end >= 0) resolve({ status: Number(raw.slice(0, end).split(" ")[1]), raw, connection });
    });
    connection.write(head);
    cleanups.push(() => void connection.destroy());
  });
}

const connect = (target: string, headers = "") => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${headers}\r\n`;

async function proxy(options: Partial<Parameters<typeof startEgressProxy>[0]> = {}): Promise<{ proxy: EgressProxy; socket: string; dialed: Array<[string, number]> }> {
  const socket = await socketPath();
  const dialed: Array<[string, number]> = [];
  const echoPort = await echoServer();
  const started = await startEgressProxy({
    socketPath: socket,
    allowedHosts: ["registry.example.com"],
    resolve: async () => ["203.0.113.7"],
    dial: (address, port) => {
      dialed.push([address, port]);
      return net.connect(echoPort, "127.0.0.1");
    },
    ...options,
  });
  cleanups.push(() => started.close());
  return { proxy: started, socket, dialed };
}

describe("EgressProxy", () => {
  test("tunnels CONNECT host:443 to the resolved address for an allowed host", async () => {
    const { socket, dialed } = await proxy();
    const { status, connection } = await request(socket, connect("registry.example.com:443"));
    expect(status).toBe(200);
    const reply = new Promise<string>((resolve) => connection.once("data", (chunk) => resolve(chunk.toString())));
    connection.write("hello");
    expect(await reply).toBe("pong:hello");
    expect(dialed).toEqual([["203.0.113.7", 443]]);
  });

  test("rejects hosts that are not listed, including subdomains and different case tricks", async () => {
    const { socket, dialed } = await proxy();
    for (const target of ["api.github.com:443", "evil.registry.example.com:443", "example.com:443"]) {
      expect((await request(socket, connect(target))).status).toBe(403);
    }
    expect(dialed).toEqual([]);
  });

  test("rejects any port other than 443", async () => {
    const { socket } = await proxy();
    expect((await request(socket, connect("registry.example.com:80"))).status).toBe(403);
    expect((await request(socket, connect("registry.example.com"))).status).toBe(403);
  });

  test("rejects IP-literal targets even when the policy lists them", async () => {
    const { socket, dialed } = await proxy({ allowedHosts: ["registry.example.com", "1.2.3.4", "127.0.0.1"] });
    for (const target of ["1.2.3.4:443", "127.0.0.1:443", "[::1]:443", "2130706433:443", "0x7f000001:443"]) {
      expect((await request(socket, connect(target))).status).toBe(403);
    }
    expect(dialed).toEqual([]);
  });

  test.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1",
  ])("rejects a DNS answer in a non-public range: %s", async (address) => {
    const { socket, dialed } = await proxy({ resolve: async () => [address] });
    expect((await request(socket, connect("registry.example.com:443"))).status).toBe(403);
    expect(dialed).toEqual([]);
  });

  test("rejects when any DNS answer is non-public", async () => {
    const { socket } = await proxy({ resolve: async () => ["203.0.113.7", "10.0.0.1"] });
    expect((await request(socket, connect("registry.example.com:443"))).status).toBe(403);
  });

  test("answers 502 when the host does not resolve", async () => {
    const { socket } = await proxy({ resolve: async () => [] });
    expect((await request(socket, connect("registry.example.com:443"))).status).toBe(502);
  });

  test("requires the Basic proxy token when one is configured", async () => {
    const { socket } = await proxy({ token: "s3cret" });
    const good = `Proxy-Authorization: Basic ${Buffer.from("conveyor:s3cret").toString("base64")}\r\n`;
    const bad = `Proxy-Authorization: Basic ${Buffer.from("conveyor:wrong").toString("base64")}\r\n`;
    expect((await request(socket, connect("registry.example.com:443"))).status).toBe(407);
    expect((await request(socket, connect("registry.example.com:443", bad))).status).toBe(407);
    expect((await request(socket, connect("registry.example.com:443", good))).status).toBe(200);
  });

  test("answers plain HTTP requests with 403", async () => {
    const { socket } = await proxy();
    const { status } = await request(socket, "GET http://registry.example.com/ HTTP/1.1\r\nHost: registry.example.com\r\n\r\n");
    expect(status).toBe(403);
  });

  test("checks every CONNECT independently on the same proxy", async () => {
    const { socket } = await proxy();
    expect((await request(socket, connect("registry.example.com:443"))).status).toBe(200);
    expect((await request(socket, connect("api.github.com:443"))).status).toBe(403);
  });
});
