import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { startRunNetwork, type RunNetwork } from "../../src/isolation/run-network";
import { bwrapUnavailableReason } from "../support/bwrap";
import { shortTemporaryDirectory } from "../support/short-temporary-directory";

const unavailable = bwrapUnavailableReason();
const describeSandbox = unavailable ? describe.skip : describe;
if (unavailable) console.warn(`SKIPPED TCP local-service tests: \`bwrap --unshare-net\` is unavailable (${unavailable})`);
setDefaultTimeout(30_000);

function listenTcp(label: string): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer((connection) => connection.on("data", (chunk) => connection.write(`${label}:${chunk}`)));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as net.AddressInfo).port }));
  });
}

const closeServer = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

async function probe(network: RunNetwork, port: number): Promise<string> {
  const sandboxed = network.wrap({ PATH: process.env.PATH ?? "" }, () => [process.execPath, "-e", `
    const net = require("node:net");
    const socket = net.connect(Number(process.argv[1]), "127.0.0.1");
    const done = (result) => { console.log(result); process.exit(0); };
    const timeout = setTimeout(() => done("timeout"), 1500);
    socket.on("connect", () => socket.write("ping"));
    socket.on("data", (chunk) => { clearTimeout(timeout); socket.destroy(); done(chunk.toString()); });
    socket.on("error", () => { clearTimeout(timeout); done("denied"); });
  `, String(port)]);
  const child = Bun.spawn(sandboxed.argv, { env: sandboxed.env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`probe exited ${code}: ${err}`);
  return out.trim();
}

describeSandbox("declared loopback TCP local services (bwrap --unshare-net)", () => {
  let directory: string;
  let declared: Awaited<ReturnType<typeof listenTcp>>;
  let undeclared: Awaited<ReturnType<typeof listenTcp>>;
  let network: RunNetwork;
  const sandboxPort = 45_433;

  beforeAll(async () => {
    directory = await shortTemporaryDirectory("conveyor-tcp-svc-", { socketPath: "service-45433.sock", visibleInSandbox: true });
    declared = await listenTcp("declared");
    undeclared = await listenTcp("undeclared");
    network = await startRunNetwork({
      directory: path.join(directory, "net"),
      policy: {
        httpsHosts: [],
        controlPlaneHosts: [],
        localServices: [{ port: sandboxPort, tcp: { host: "127.0.0.1", port: declared.port } }],
      },
    });
  });

  afterAll(async () => {
    await network?.close();
    await Promise.all([declared && closeServer(declared.server), undeclared && closeServer(undeclared.server)]);
    await rm(directory, { recursive: true, force: true });
  });

  test("the declared sandbox loopback endpoint reaches the configured host TCP listener", async () => {
    expect(await probe(network, sandboxPort)).toBe("declared:ping");
  });

  test("a host TCP listener that was not declared stays unreachable in the same command", async () => {
    expect(await probe(network, undeclared.port)).toBe("denied");
  });
});
