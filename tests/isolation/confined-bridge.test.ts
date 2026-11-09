import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { sandboxCommand } from "../../src/isolation/sandbox";
import { BUILD } from "../../src/version";

const cli = path.join(import.meta.dir, "../../src/cli.ts");
let root: string;
const compiledBefore = BUILD.compiled;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "confined-bridge-"));
  await writeFile(path.join(root, "bwrap"), "#!/bin/sh\n");
  await chmod(path.join(root, "bwrap"), 0o755);
});
afterEach(async () => {
  BUILD.compiled = compiledBefore;
  await rm(root, { recursive: true, force: true });
});

function confinedArgv(compiled: boolean): { argv: string[]; mounts: string[] } {
  BUILD.compiled = compiled;
  const mounts = ["--ro-bind", "/usr", "/usr"];
  const launch = sandboxCommand({ argv: ["codex"], env: { PATH: root }, dataProxySocket: "/run/d.sock", filesystem: { mounts } as never });
  return { argv: launch.argv, mounts };
}

describe("the confined egress wrapper's bridge command", () => {
  test("a compiled build ends the argv with `<executable> __bridge <spec>`", () => {
    const { argv } = confinedArgv(true);
    const separator = argv.indexOf("--");
    expect(argv.slice(separator + 1, separator + 3)).toEqual([process.execPath, "__bridge"]);
    expect(JSON.parse(argv[argv.length - 1]!)).toMatchObject({ command: ["codex"] });
    expect(argv.length).toBe(separator + 4);
  });

  test("a compiled build's argv contains no -e", () => {
    expect(confinedArgv(true).argv).not.toContain("-e");
  });

  test("a source checkout keeps `process.execPath -e <inline bridge>`", () => {
    const { argv } = confinedArgv(false);
    const separator = argv.indexOf("--");
    expect(argv.slice(separator + 1, separator + 3)).toEqual([process.execPath, "-e"]);
    expect(argv[separator + 3]).toContain("sandbox bridge failed");
  });

  test("a source checkout adds no checkout path to the mounts", () => {
    const { argv, mounts } = confinedArgv(false);
    expect(argv.slice(0, argv.indexOf("--"))).toEqual([path.join(root, "bwrap"), "--unshare-net", "--unshare-pid", "--die-with-parent", ...mounts]);
  });
});

async function bridge(spec: unknown): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn([process.execPath, cli, "__bridge", JSON.stringify(spec)], { stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, stdout };
}

describe("the `__bridge` command", () => {
  test("forwards a declared port to its socket (real sockets)", async () => {
    const socket = path.join(root, "up.sock");
    const upstream = net.createServer((client) => client.on("data", (data) => client.end(`echo:${data}`)));
    await new Promise<void>((ok) => upstream.listen(socket, ok));
    const probe = net.createServer();
    await new Promise<void>((ok) => probe.listen(0, "127.0.0.1", ok));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise((ok) => probe.close(ok));
    const client = `const w=()=>require("node:net").connect(${port},"127.0.0.1").on("connect",function(){this.write("ping");this.on("data",d=>{console.log(String(d));process.exit(0)})}).on("error",()=>setTimeout(w,50));w()`;
    const result = await bridge({ forwards: [{ port, socket }], command: [process.execPath, "-e", client] });
    upstream.close();
    expect(result.stdout).toContain("echo:ping");
    expect(result.code).toBe(0);
  });

  test("exits with the agent's exit code", async () => {
    expect((await bridge({ forwards: [], command: ["sh", "-c", "exit 7"] })).code).toBe(7);
  });

  test("exits with 128 plus the signal number when the agent is killed", async () => {
    expect((await bridge({ forwards: [], command: ["sh", "-c", "kill -TERM $$"] })).code).toBe(128 + 15);
    expect((await bridge({ forwards: [], command: ["sh", "-c", "kill -KILL $$"] })).code).toBe(128 + 9);
  });
});
