import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { piDoctorCheck, piPlugin } from "../../../src/plugins/pi";
import { PLUGINS } from "../../../src/plugins";
import { installFakePi, installOfficialFakePi } from "../../support/fake-pi";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("pi plugin", () => {
  test("is registered as the harness for runners of type pi, with session resume and agent egress", () => {
    expect(PLUGINS).toContain(piPlugin);
    const harness = piPlugin.create({ config: {} as never, shared: (_key, create) => create() });
    expect(harness.capabilities).toEqual({ sessionResume: true });
    expect(piPlugin.profile).toMatchObject({ sandbox: "access", optionalShell: true, confinedAccess: false, workspaceWriteNeedsNetwork: true, agentEgress: true });
    // Its control-plane hosts follow the runner's provider; none without one Conveyor knows.
    expect(piPlugin.profile.controlPlaneHosts).toEqual([]);
    expect(piPlugin.profile.controlPlaneHostsFor?.({ type: "pi", command: "pi", provider: "openai" } as never)).toEqual(["api.openai.com", "auth.openai.com"]);
    expect(piPlugin.profile.controlPlaneHostsFor?.({ type: "pi", command: "pi" })).toEqual([]);
    expect(harness.runEphemeral).toBeUndefined();
    expect(harness.check).toBeUndefined();
    expect(harness.steer).toBeUndefined();
  });

  test("doctor reports an installed pi with its interpreter, and fails a command that is not pi's package", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "conveyor-pi-doctor-")));
    directories.push(root);
    const { command, packageRoot } = await installFakePi(root, "");
    const check = (runnerCommand: string, found: string | null) => piDoctorCheck({
      runnerName: "pi", runner: { type: "pi", command: runnerCommand }, findTool: () => found,
    });

    expect(check(command, command)).toMatchObject({ name: "harness pi", status: "ok", detail: expect.stringContaining(path.join(packageRoot, "dist", "bundle", "cli.js")) });
    expect(check("pi", null)).toMatchObject({ status: "fail", detail: "pi is not on PATH" });
    const loose = path.join(root, "loose-pi");
    await writeFile(loose, "#!/bin/sh\n", { mode: 0o755 });
    expect(check(loose, loose)).toMatchObject({ status: "fail", detail: expect.stringContaining("is not part of an installed"), fix: expect.stringContaining("@earendil-works/pi-coding-agent") });
  });

  test("doctor reports the official installer's release and Node, and fails a launcher whose release is missing", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "conveyor-pi-doctor-")));
    directories.push(root);
    const home = path.join(root, "home");
    const official = await installOfficialFakePi(path.join(home, ".pi", "agent"), "", { dataHome: path.join(home, ".local", "share") });
    const check = () => piDoctorCheck({ runnerName: "pi", runner: { type: "pi", command: "pi" }, findTool: () => official.launcher }, { HOME: home, PATH: path.dirname(official.launcher) });

    expect(check()).toMatchObject({ status: "ok", detail: `pi 1.5.2 (official installer): ${official.cli} on ${await realpath(process.execPath)}` });
    await writeFile(path.join(home, ".pi", "agent", "install", "current-version"), "2.0.0\n");
    expect(check()).toMatchObject({ status: "fail", detail: expect.stringContaining("names release 2.0.0, but"), fix: expect.stringContaining("official installer") });
  });
});
