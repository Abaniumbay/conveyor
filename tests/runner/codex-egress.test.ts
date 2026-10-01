import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCodex } from "../../src/runner/codex";

const bwrap = Bun.spawnSync(["bwrap", "--unshare-net", "--dev-bind", "/", "/", "true"], { stderr: "pipe" });
const available = bwrap.exitCode === 0;
if (!available) console.warn("SKIPPED codex egress tests: `bwrap --unshare-net` is unavailable");
const describeSandbox = available ? describe : describe.skip;

const directories: string[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const FAKE_CODEX = `#!/usr/bin/env bun
import net from "node:net";
const args = process.argv.slice(2);
await new Response(Bun.stdin.stream()).text();
const proxy = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null;
const status = !proxy ? "none" : await new Promise((resolve) => {
  const socket = net.connect(Number(proxy.port), proxy.hostname);
  let raw = "";
  socket.on("error", (e) => resolve(e.code));
  socket.on("data", (c) => { raw += c; if (raw.includes("\\r\\n\\r\\n")) { socket.destroy(); resolve(raw.split(" ")[1]); } });
  const auth = Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64");
  socket.write("CONNECT model.fake.test:443 HTTP/1.1\\r\\nHost: model.fake.test:443\\r\\nProxy-Authorization: Basic " + auth + "\\r\\n\\r\\n");
});
await Bun.write(process.env.CAPTURE, JSON.stringify({ args, status, proxy: process.env.HTTPS_PROXY, httpProxy: process.env.HTTP_PROXY }));
await Bun.write(args[args.indexOf("-o") + 1], JSON.stringify({ version: 1, outcome: "success", status: "done", summary: "ok", reason: null, metrics: {}, artifacts: [] }));
`;

async function run(egress: boolean) {
  const directory = await mkdtemp(path.join(tmpdir(), "cx-"));
  directories.push(directory);
  const workspace = path.join(directory, "workspace");
  const artifacts = path.join(directory, "artifacts", "run-1");
  await mkdir(workspace);
  const executable = path.join(directory, "codex");
  await writeFile(executable, FAKE_CODEX);
  await chmod(executable, 0o755);
  const model = net.createServer((socket) => socket.on("error", () => {}));
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  servers.push(model);
  const capture = path.join(directory, "capture.json");
  await runCodex({
    command: executable,
    workspace,
    artifactsDirectory: artifacts,
    prompt: "go",
    sandbox: "workspace-write",
    automaticApprovals: false,
    mcp: { command: "bun", args: ["x"] },
    env: { CAPTURE: capture },
    ...(egress
      ? {
          egress: {
            httpsHosts: ["registry.fake.test"],
            controlPlaneHosts: ["model.fake.test"],
            resolve: async () => ["203.0.113.1"],
            dial: () => net.connect((model.address() as net.AddressInfo).port, "127.0.0.1"),
          },
        }
      : {}),
  });
  return { capture: JSON.parse(await readFile(capture, "utf8")), artifacts };
}

describeSandbox("runCodex with agent egress", () => {
  test("runs codex in the sandbox with a token control-plane proxy and a data-plane shell policy", async () => {
    const { capture, artifacts } = await run(true);
    expect(capture.status).toBe("200");
    expect(capture.proxy).toMatch(/^http:\/\/conveyor:[A-Za-z0-9_%-]{20,}@127\.0\.0\.1:\d+$/);
    expect(capture.httpProxy).toBe("");
    const args: string[] = capture.args;
    const set = args.find((arg) => arg.startsWith("shell_environment_policy.set="))!;
    expect(set).toMatch(/HTTPS_PROXY="http:\/\/127\.0\.0\.1:\d+"/);
    expect(set).not.toContain("conveyor:");
    expect(set).toContain('NO_PROXY=""');
    const exclude = args.find((arg) => arg.startsWith("shell_environment_policy.exclude="))!;
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "npm_config_https_proxy", "NO_PROXY"]) {
      expect(exclude).toContain(`"${name}"`);
    }
    expect(args).toContain("sandbox_workspace_write.network_access=true");
    // Per-run network state is removed after the run.
    expect(await readdir(path.join(artifacts, "net"))).toEqual([]);
  });

  test("without an egress policy codex runs as before (no sandbox flags)", async () => {
    const { capture } = await run(false);
    expect(capture.status).toBe("none");
    expect(capture.args.some((arg: string) => arg.startsWith("shell_environment_policy"))).toBe(false);
  });
});
