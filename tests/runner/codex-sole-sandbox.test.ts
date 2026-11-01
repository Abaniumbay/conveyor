import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { runCodex } from "../../src/runner/codex";
import { runCodexCheck } from "../../src/runner/codex-check";
import { bwrapUnavailableReason } from "../support/bwrap";
import { shortTemporaryDirectory } from "../support/short-temporary-directory";

type Mode = "read-only" | "workspace-write" | "danger-full-access";

const unavailable = bwrapUnavailableReason();
if (unavailable) console.warn(`SKIPPED codex sole-sandbox egress tests: \`bwrap --unshare-net\` is unavailable (${unavailable})`);
const describeWrapped = unavailable ? describe.skip : describe;

const directories: string[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const FAKE_CODEX = `#!/usr/bin/env bun
const args = process.argv.slice(2);
await new Response(Bun.stdin.stream()).text();
await Bun.write(process.env.CAPTURE, JSON.stringify({ args }));
const result = process.env.KIND === "check"
  ? { version: 1, decision: "pass", status: "done", reason: null, evidence: [], requiredFixes: [], criteria: [] }
  : { version: 1, outcome: "success", status: "done", summary: "ok", reason: null, metrics: {}, artifacts: [] };
await Bun.write(args[args.indexOf("-o") + 1], JSON.stringify(result));
`;

async function launch(kind: "run" | "check", sandbox: Mode, egress: boolean, resume = false): Promise<string[]> {
  const directory = await shortTemporaryDirectory("conveyor-cs-", { socketPath: "artifacts/run-1/net/control.sock", visibleInSandbox: true });
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
  const capture = path.join(artifacts, "capture.json");
  const input = {
    command: executable,
    workspace,
    artifactsDirectory: artifacts,
    prompt: "go",
    sandbox,
    automaticApprovals: true,
    mcp: { command: "bun", args: ["x"] },
    env: { CAPTURE: capture, KIND: kind },
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
  };
  if (kind === "check") await runCodexCheck(input);
  else await runCodex({ ...input, ...(resume ? { resumeSessionId: "sess-1", persistSession: true } : {}) });
  return (JSON.parse(await readFile(capture, "utf8")) as { args: string[] }).args;
}

function sandboxFlag(args: string[]): string | undefined {
  return args[args.indexOf("--sandbox") + 1];
}

describeWrapped("Codex sandbox selection", () => {
  test("fresh workspace-write run with agentEgress disables Codex's own sandbox", async () => {
    const args = await launch("run", "workspace-write", true);
    expect(sandboxFlag(args)).toBe("danger-full-access");
    expect(args).not.toContain("--approve-for-me");
  });

  test("fresh read-only run with agentEgress disables Codex's own sandbox", async () => {
    const args = await launch("run", "read-only", true);
    expect(sandboxFlag(args)).toBe("danger-full-access");
    expect(args).not.toContain("--approve-for-me");
  });

  test("fresh danger-full-access run with agentEgress disables Codex's own sandbox", async () => {
    const args = await launch("run", "danger-full-access", true);
    expect(sandboxFlag(args)).toBe("danger-full-access");
    expect(args).not.toContain("--approve-for-me");
  });

  test("resumed run with agentEgress disables Codex's own sandbox", async () => {
    const args = await launch("run", "workspace-write", true, true);
    expect(args).toContain('sandbox_mode="danger-full-access"');
    expect(args).not.toContain('sandbox_mode="workspace-write"');
  });

  test("legacy check with agentEgress disables Codex's own sandbox", async () => {
    const args = await launch("check", "read-only", true);
    expect(sandboxFlag(args)).toBe("danger-full-access");
  });

  test("fresh run without agentEgress keeps the configured mode", async () => {
    expect(sandboxFlag(await launch("run", "read-only", false))).toBe("read-only");
  });

  test("resumed run without agentEgress keeps the configured mode", async () => {
    expect(await launch("run", "read-only", false, true)).toContain('sandbox_mode="read-only"');
  });

  test("legacy check without agentEgress keeps the configured mode", async () => {
    expect(sandboxFlag(await launch("check", "workspace-write", false))).toBe("workspace-write");
  });
});
