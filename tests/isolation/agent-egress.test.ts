import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ConveyorConfig } from "../../src/config/load";
import { agentEgressFor } from "../../src/isolation/agent-egress";

function config(agentEgress: unknown): ConveyorConfig {
  return {
    web: { listen: "127.0.0.1:8123" },
    settings: { artifacts: "/data/artifacts" },
    repositories: { app: { agentEgress }, legacy: {} },
  } as unknown as ConveyorConfig;
}

describe("agentEgressFor", () => {
  test("repositories without an agentEgress block are not sandboxed", () => {
    expect(agentEgressFor(config({}), "legacy", {})).toBeUndefined();
    expect(agentEgressFor(config({}), "missing", {})).toBeUndefined();
  });

  test("forwards the exact web port to the MCP-only socket when loopback MCP is allowed", () => {
    expect(
      agentEgressFor(config({ allowLoopbackMcp: true, httpsHosts: ["registry.npmjs.org"] }), "app", { controlPlaneHosts: ["x.example.com"] }),
    ).toEqual({
      httpsHosts: ["registry.npmjs.org"],
      controlPlaneHosts: ["x.example.com"],
      mcp: { port: 8123, socket: "/data/artifacts/mcp.sock" },
    });
  });

  test("omits the MCP forward when loopback MCP is disallowed", () => {
    expect(agentEgressFor(config({ allowLoopbackMcp: false, httpsHosts: [] }), "app", {})?.mcp).toBeUndefined();
  });

  test("rejects a local service port that collides with the loopback MCP port", () => {
    const egress = (allowLoopbackMcp: boolean) => config({
      allowLoopbackMcp,
      httpsHosts: [],
      localServices: [{ name: "postgres", socket: "/run/pg.sock", endpoint: "127.0.0.1:8123", environment: {} }],
    });
    expect(() => agentEgressFor(egress(true), "app", {})).toThrow("collides with the loopback MCP port");
    expect(agentEgressFor(egress(false), "app", {})?.localServices).toEqual([{ port: 8123, socket: "/run/pg.sock" }]);
  });

  test("rejects a Docker socket before starting an agent", () => {
    expect(() => agentEgressFor(config({
      allowLoopbackMcp: false,
      httpsHosts: [],
      localServices: [{
        name: "postgres",
        socket: "/var/run/docker.sock",
        endpoint: "127.0.0.1:5432",
        environment: {},
      }],
    }), "app", {})).toThrow("must not forward the host Docker socket");
  });

  test("rejects a local socket path that resolves through a Docker directory alias", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "conveyor-egress-"));
    try {
      symlinkSync("/var/run", path.join(directory, "run"));
      expect(() => agentEgressFor(config({
        allowLoopbackMcp: false,
        httpsHosts: [],
        localServices: [{
          name: "postgres",
          socket: path.join(directory, "run", "docker.sock"),
          endpoint: "127.0.0.1:5432",
          environment: {},
        }],
      }), "app", {})).toThrow("must not forward the host Docker socket");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("forwards services and connection variables only for the declaring repository", () => {
    const policy = agentEgressFor(config({
      allowLoopbackMcp: false,
      httpsHosts: [],
      localServices: [{
        name: "postgres",
        socket: "/run/postgresql/.s.PGSQL.5432",
        endpoint: "127.0.0.1:5432",
        environment: {
          DATABASE_URL: "postgres://conveyor@127.0.0.1:5432/test",
        },
      }],
    }), "app", {});

    expect(policy?.localServices).toEqual([
      { port: 5432, socket: "/run/postgresql/.s.PGSQL.5432" },
    ]);
    expect(policy?.localServiceEnvironment).toEqual({
      DATABASE_URL: "postgres://conveyor@127.0.0.1:5432/test",
    });
    expect(agentEgressFor(config({}), "legacy", {})).toBeUndefined();
  });
});
