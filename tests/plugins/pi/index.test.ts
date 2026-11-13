import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { piDoctorCheck, piPlugin } from "../../../src/plugins/pi";
import { PLUGINS } from "../../../src/plugins";
import { installFakePi } from "../../support/fake-pi";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("pi plugin", () => {
  test("is registered as the harness for runners of type pi, with session resume and no egress", () => {
    expect(PLUGINS).toContain(piPlugin);
    const harness = piPlugin.create({ config: {} as never, shared: (_key, create) => create() });
    expect(harness.capabilities).toEqual({ sessionResume: true });
    expect(piPlugin.profile).toMatchObject({ sandbox: "access", optionalShell: true, confinedAccess: false, workspaceWriteNeedsNetwork: true, agentEgress: false });
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
});
