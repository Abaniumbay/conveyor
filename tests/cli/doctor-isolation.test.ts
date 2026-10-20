import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { configuredCodexIsolationChecks, type DoctorCommand } from "../../src/cli/commands/doctor";

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
    const checks = await configuredCodexIsolationChecks(config(true), succeeds);

    expect(checks).toEqual([
      { name: "Codex egress namespaces", status: "ok", detail: "bwrap can create network and PID namespaces" },
      { name: "Codex egress mounts", status: "ok", detail: "bwrap can create the required filesystem mounts" },
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
      fix: "allow bwrap to create mount namespaces and bind, proc, and tmpfs mounts (for example: grant the required AppArmor profile permissions)",
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
