import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { probeMcpServer, probeMcpServers } from "../../src/isolation/mcp-probe";
import { bwrapUnavailableReason } from "../support/bwrap";

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

async function script(source: string): Promise<{ command: string; args: string[]; env: Record<string, string> }> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-mcp-"));
  directories.push(directory);
  const file = path.join(directory, "server.js");
  await writeFile(file, source);
  return { command: process.execPath, args: [file], env: {} };
}

const answering = `
process.stdin.on("data", (chunk) => {
  for (const line of String(chunk).split("\\n").filter(Boolean)) {
    const { id, method } = JSON.parse(line);
    if (method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake", version: "1" } } }) + "\\n");
  }
});
`;

describe("probeMcpServer", () => {
  test("a server that exits at once is reported with its exit status and stderr tail", async () => {
    const server = await script(`console.error("boom: cannot open project"); process.exit(3);`);
    const result = await probeMcpServer(server, { cwd: tmpdir() });
    expect(result).toMatchObject({ ok: false, reason: "exited" });
    expect(result.ok ? "" : result.detail).toContain("status 3");
    expect(result.ok ? "" : result.detail).toContain("boom: cannot open project");
  });

  test("a server that never answers initialize is reported as not answering within its startup timeout", async () => {
    const server = await script(`setInterval(() => {}, 1000);`);
    const result = await probeMcpServer({ ...server, startupTimeoutSec: 0.3 }, { cwd: tmpdir() });
    expect(result).toEqual({ ok: false, reason: "timeout", detail: "did not answer initialize within 0.3s" });
  });

  test("a server that answers initialize passes", async () => {
    expect(await probeMcpServer(await script(answering), { cwd: tmpdir() })).toEqual({ ok: true });
  });

  test("a command that cannot be started is reported", async () => {
    const result = await probeMcpServer({ command: "/nonexistent/mcp-server", args: [], env: {} }, { cwd: tmpdir() });
    expect(result).toMatchObject({ ok: false, reason: "spawn" });
  });

  test("probeMcpServers returns only the failed servers, by name", async () => {
    const failures = await probeMcpServers(
      { good: await script(answering), bad: await script(`console.error("nope"); process.exit(1);`) },
      { cwd: tmpdir() },
    );
    expect(failures.map((f) => f.server)).toEqual(["bad"]);
    expect(failures[0]!.detail).toContain("nope");
  });
});

describe("probeMcpServer deadline", () => {
  test("a server that closes its output but keeps running is reported within the startup timeout", async () => {
    const started = performance.now();
    const result = await probeMcpServer(
      { command: "/bin/sh", args: ["-c", "exec 1>&-; sleep 5"], env: {}, startupTimeoutSec: 0.3 },
      { cwd: tmpdir() },
    );
    expect(result.ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

const unavailable = bwrapUnavailableReason();
describe.skipIf(unavailable !== null)("probeAgentMcpServers in the agent sandbox", () => {
  test("a server runs inside the sandbox and is told apart from one that fails", async () => {
    const { probeAgentMcpServers } = await import("../../src/isolation/mcp-probe");
    const workspace = await mkdtemp(path.join(tmpdir(), "conveyor-mcp-ws-"));
    directories.push(workspace);
    const inline = (code: string) => ({ command: process.execPath, args: ["-e", code], env: {} });
    const failures = await probeAgentMcpServers(
      { good: inline(answering), bad: inline(`console.error("sandboxed boom"); process.exit(2);`) },
      { workspace },
    );
    expect(failures.map((f) => f.server)).toEqual(["bad"]);
    expect(failures[0]!.detail).toContain("sandboxed boom");
  });
});
