import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { mcpServerChecks, configuredCodexIsolationChecks, type DoctorCommand } from "../../src/cli/commands/doctor";

interface IsolationConfig {
  agents: Record<string, { runner: string }>;
  runners: Record<string, { type: string }>;
  repositories: Record<string, { agentEgress?: object | undefined }>;
}

const config = (agentEgress: boolean): IsolationConfig => ({
  agents: {
    codex: { runner: "codex" },
  },
  runners: {
    codex: { type: "codex" },
  },
  repositories: {
    app: {
      agentEgress: agentEgress ? { allowLoopbackMcp: true, httpsHosts: [] } : undefined,
    },
  },
});

const succeeds: DoctorCommand = async () => ({ code: 0, output: "" });

describe("configured Codex isolation doctor checks", () => {
  test("the operator guide describes configured Codex isolation diagnostics", async () => {
    const guide = await readFile(path.join(import.meta.dir, "../../docs/operations.md"), "utf8");

    expect(guide).toContain("`agentEgress` report network and PID namespace support");
    expect(guide).toContain("the filesystem mounts required by Conveyor's bubblewrap egress wrapper");
    expect(guide).toMatch(/Without `agentEgress`, the\s+check instead reports/);
    expect(guide).toContain("the user namespace required by Codex's own sandbox");
  });

  test("reports egress namespace and filesystem-mount isolation as available", async () => {
    const commands: string[][] = [];
    const checks = await configuredCodexIsolationChecks(config(true), async (argv) => {
      commands.push(argv);
      return { code: 0, output: "" };
    });

    expect(checks).toEqual([
      { name: "Codex egress namespaces", status: "ok", detail: "bwrap can create network and PID namespaces" },
      { name: "Codex egress mounts", status: "ok", detail: "bwrap can create the required filesystem mounts" },
    ]);
    expect(commands).toEqual([
      ["bwrap", "--unshare-net", "--unshare-pid", "--die-with-parent", "--dev-bind", "/", "/", "--", "true"],
      ["bwrap", "--unshare-net", "--unshare-pid", "--die-with-parent", "--dev-bind", "/", "/", "--proc", "/proc", "--tmpfs", "/tmp", "--", "true"],
    ]);
  });

  test("names and explains a denied egress namespace capability", async () => {
    const checks = await configuredCodexIsolationChecks(config(true), async (argv) =>
      argv.includes("--unshare-net") ? { code: 1, output: "Creating network namespace failed: Operation not permitted" } : { code: 0, output: "" },
    );

    expect(checks[0]).toEqual({
      name: "Codex egress namespaces",
      status: "fail",
      detail: "bwrap cannot create the network and PID namespaces required for Codex egress isolation: Creating network namespace failed: Operation not permitted",
      fix: "allow unprivileged user namespaces and network/PID namespace creation for bwrap (for example: sysctl kernel.apparmor_restrict_unprivileged_userns=0, or an AppArmor profile for bwrap)",
    });
  });

  test("names and explains a denied egress filesystem mount capability", async () => {
    const checks = await configuredCodexIsolationChecks(config(true), async (argv) =>
      argv.includes("--tmpfs") ? { code: 1, output: "Creating new namespace failed: Operation not permitted" } : { code: 0, output: "" },
    );

    expect(checks[1]).toEqual({
      name: "Codex egress mounts",
      status: "fail",
      detail: "bwrap cannot create the filesystem mounts required for Codex egress isolation: Creating new namespace failed: Operation not permitted",
      fix: "allow bwrap to create the bind, proc, and tmpfs mounts in its mount namespace (for example: grant bwrap mount permissions in the host's AppArmor profile)",
    });
  });

  test("reports the user namespace required by an unwrapped Codex sandbox", async () => {
    const checks = await configuredCodexIsolationChecks(config(false), succeeds);

    expect(checks).toEqual([
      { name: "Codex sandbox namespaces", status: "ok", detail: "bwrap can create the user namespace required by the Codex sandbox" },
    ]);
  });

  test("names the user namespace when an unwrapped Codex sandbox cannot create it", async () => {
    const checks = await configuredCodexIsolationChecks(config(false), async () =>
      ({ code: 1, output: "No permissions to create a new namespace" }),
    );

    expect(checks).toEqual([
      {
        name: "Codex sandbox namespaces",
        status: "fail",
        detail: "bwrap cannot create the user namespace required by the Codex sandbox: No permissions to create a new namespace",
        fix: "allow unprivileged user namespaces for Codex (for example: sysctl kernel.apparmor_restrict_unprivileged_userns=0, or an AppArmor profile for bwrap)",
      },
    ]);
  });
});

describe("MCP server doctor checks", () => {
  const server = { command: "serena", args: [], env: {} };
  const agents = { darya: { mcpServers: { serena: server, other: server } }, plain: {} };

  test("a server that does not answer initialize fails, naming the agent and the server", async () => {
    const checks = await mcpServerChecks({ agents }, async () => [{ server: "serena", detail: "exited with status 1 before answering initialize: boom" }]);
    expect(checks.find((c) => c.name === "mcp darya/serena")).toMatchObject({ status: "fail" });
    expect(checks.find((c) => c.name === "mcp darya/serena")!.detail).toContain("serena of agent darya");
    expect(checks.find((c) => c.name === "mcp darya/other")).toMatchObject({ status: "ok" });
  });

  test("every server answering passes, and each agent is probed once", async () => {
    let probes = 0;
    const checks = await mcpServerChecks({ agents }, async () => { probes += 1; return []; });
    expect(checks.map((c) => c.status)).toEqual(["ok", "ok"]);
    expect(probes).toBe(1);
  });
  test("each agent is probed with the repositories' toolchain directories and egress policy", async () => {
    const tools = await mkdtemp(path.join(tmpdir(), "conveyor-doctor-tools-"));
    try {
      const full = {
        root: "/nonexistent-root", settings: { database: "/x/db", logs: "/x/l", workspaces: "/x/w", artifacts: "/x/a" },
        web: { listen: "127.0.0.1:8080" },
        repositories: { r: { folder: "/x/r", agentToolchainPaths: { paths: [tools] }, agentEgress: { httpsHosts: ["example.com"] } } },
        runners: { codex: { type: "codex", controlPlaneHosts: ["api.example"] } },
        agents,
      } as unknown as Parameters<typeof mcpServerChecks>[2];
      let seen: Record<string, unknown> | undefined;
      await mcpServerChecks({ agents: { darya: { runner: "codex", workspaceAccess: "read-only", env: { A: "b" }, mcpServers: { serena: server } } } }, async (_servers, options) => { seen = options as never; return []; }, full);
      expect(seen).toMatchObject({ readOnly: true, env: { A: "b" }, writableRoots: [], toolchainPaths: [await realpath(tools)], egress: { httpsHosts: ["example.com"], controlPlaneHosts: ["api.example"] } });
    } finally {
      await rm(tools, { recursive: true, force: true });
    }
  });
});
