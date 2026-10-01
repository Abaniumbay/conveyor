import { describe, expect, test } from "bun:test";

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
});
