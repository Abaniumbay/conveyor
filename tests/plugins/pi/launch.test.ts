import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveBash } from "../../../src/isolation/environment";
import {
  PI_MCP_LAUNCH, PI_PROVIDER_CONTROL_PLANE_HOSTS, piCommandEnvironmentFile, piControlPlaneHosts, piInstallation, piMountRoot,
  piShellCommandPrefix, writePiCommandEnvironment,
} from "../../../src/plugins/pi/launch";
import { installFakePi, installOfficialFakePi } from "../../support/fake-pi";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "conveyor-pi-launch-")));
  directories.push(directory);
  return directory;
}

describe("piInstallation", () => {
  test("follows npm's bin link to the CLI script, its package root and the resolved interpreter its #! line names", async () => {
    const root = await temporary();
    const { bin, packageRoot } = await installFakePi(root, "");
    const found = piInstallation("pi", { PATH: `${bin}:${process.env.PATH}` });
    expect(found.executable).toBe(path.join(packageRoot, "dist", "bundle", "cli.js"));
    expect(found.packageRoot).toBe(packageRoot);
    expect(found.interpreter).toEqual({ path: await realpath(Bun.which("bun")!), args: [] });
    expect(found.release).toBeUndefined();
    expect(piMountRoot(found)).toBe(packageRoot);
  });

  test("launches a standalone build directly, with the directory that holds its package.json", async () => {
    const root = await temporary();
    const build = path.join(root, "pi-build");
    await mkdir(build);
    await writeFile(path.join(build, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
    await writeFile(path.join(build, "pi"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0]));
    await chmod(path.join(build, "pi"), 0o755);
    expect(piInstallation(path.join(build, "pi"), { PATH: "" })).toEqual({ executable: path.join(build, "pi"), packageRoot: build });
  });

  test("refuses a command outside pi's package, and a script whose interpreter is not installed", async () => {
    const root = await temporary();
    const loose = path.join(root, "pi");
    await writeFile(loose, "#!/usr/bin/env node\n");
    await chmod(loose, 0o755);
    expect(() => piInstallation(loose, { PATH: "" })).toThrow("is not part of an installed @earendil-works/pi-coding-agent package");

    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
    expect(() => piInstallation(loose, { PATH: path.join(root, "empty") })).toThrow("runs on node, which cannot be found on PATH");
  });
});

describe("piInstallation with pi's official installer", () => {
  test("resolves the launcher to the current release's CLI and the installer's Node, as the launcher would", async () => {
    const root = await temporary();
    const home = path.join(root, "home");
    const official = await installOfficialFakePi(path.join(home, ".pi", "agent"), "", { dataHome: path.join(home, ".local", "share") });
    const found = piInstallation("pi", { PATH: path.dirname(official.launcher) }, { HOME: home });
    expect(found.executable).toBe(official.cli);
    expect(found.packageRoot).toBe(official.packageRoot);
    expect(found.interpreter).toEqual({ path: await realpath(process.execPath), args: [] });
    expect(found.release).toEqual({ version: "1.5.2", directory: official.release });
    // Only that release is mounted: the package and its dependencies, never the rest of ~/.pi/agent.
    expect(piMountRoot(found)).toBe(official.release);
  });

  test("XDG_DATA_HOME locates the installer's Node, and a symlink to the launcher resolves the same way", async () => {
    const root = await temporary();
    const data = path.join(root, "data");
    const official = await installOfficialFakePi(path.join(root, "agent"), "", { dataHome: data });
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await symlink(official.launcher, path.join(bin, "pi"));
    const found = piInstallation("pi", { PATH: bin }, { XDG_DATA_HOME: data, HOME: path.join(root, "elsewhere") });
    expect(found.executable).toBe(official.cli);
    expect(found.interpreter?.path).toBe(await realpath(process.execPath));
  });

  test("without the installer's Node, node is looked up on PATH", async () => {
    const root = await temporary();
    const official = await installOfficialFakePi(path.join(root, "agent"), "");
    const nodeBin = path.join(root, "node-bin");
    await mkdir(nodeBin);
    await symlink(process.execPath, path.join(nodeBin, "node"));
    const found = piInstallation(official.launcher, { PATH: nodeBin }, { HOME: path.join(root, "home") });
    expect(found.interpreter?.path).toBe(await realpath(process.execPath));
    expect(() => piInstallation(official.launcher, { PATH: path.join(root, "empty") }, { HOME: path.join(root, "home") })).toThrow("runs on node, which cannot be found");
  });

  test("refuses an invalid version file and a missing release, as the launcher does", async () => {
    const root = await temporary();
    const agent = path.join(root, "agent");
    const official = await installOfficialFakePi(agent, "", { dataHome: path.join(root, "data") });
    const current = path.join(agent, "install", "current-version");
    for (const version of ["..", ".", "../escape", "1.5.2 beta", "", "1.5.2\nextra"]) {
      await writeFile(current, `${version}\n`);
      expect(() => piInstallation(official.launcher, { PATH: "" }, {})).toThrow("names an invalid release");
    }
    await writeFile(current, "9.9.9\n");
    expect(() => piInstallation(official.launcher, { PATH: "" }, {})).toThrow("names release 9.9.9, but");
    await writeFile(current, "1.5.2");
    expect(piInstallation(official.launcher, { PATH: "" }, { XDG_DATA_HOME: path.join(root, "data") }).release?.version).toBe("1.5.2");
  });

  test("a release whose command is not pi's package is refused", async () => {
    const root = await temporary();
    const agent = path.join(root, "agent");
    const official = await installOfficialFakePi(agent, "");
    await writeFile(path.join(official.packageRoot, "package.json"), JSON.stringify({ name: "something-else" }));
    expect(() => piInstallation(official.launcher, { PATH: "" }, {})).toThrow("is not part of an installed @earendil-works/pi-coding-agent package");
  });
});

describe("pi control-plane hosts", () => {
  test("the runner's own hosts win, else its provider's defaults, else none", () => {
    expect(piControlPlaneHosts({ controlPlaneHosts: ["model.example.com"], provider: "anthropic" })).toEqual(["model.example.com"]);
    expect(piControlPlaneHosts({ provider: "anthropic" })).toEqual(["api.anthropic.com", "platform.claude.com"]);
    expect(piControlPlaneHosts({ provider: "openai-codex" })).toEqual(["chatgpt.com", "auth.openai.com"]);
    expect(piControlPlaneHosts({ provider: "azure" })).toEqual([]);
    expect(piControlPlaneHosts({ provider: "toString" })).toEqual([]);
    expect(piControlPlaneHosts({})).toEqual([]);
  });

  test("the defaults are pi's provider hosts and never a source-provider API", () => {
    expect(PI_PROVIDER_CONTROL_PLANE_HOSTS).toEqual({
      anthropic: ["api.anthropic.com", "platform.claude.com"],
      openai: ["api.openai.com", "auth.openai.com"],
      "openai-codex": ["chatgpt.com", "auth.openai.com"],
      google: ["generativelanguage.googleapis.com"],
      openrouter: ["openrouter.ai"],
    });
  });
});

describe("the command environment of pi's commands", () => {
  const bash = resolveBash()!;
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const fixture = async () => {
    const root = await temporary();
    const file = piCommandEnvironmentFile(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writePiCommandEnvironment(file, { unset: ["PI_CODING_AGENT_DIR", "EXAMPLE_API_KEY"], dataEnv: { HTTPS_PROXY: "http://127.0.0.1:3128", NO_PROXY: "it's" } });
    return { root, file };
  };
  const processEnvironment = { PATH: process.env.PATH ?? "", PI_CODING_AGENT_DIR: "/private/agent", EXAMPLE_API_KEY: "secret", HTTPS_PROXY: "http://conveyor:token@127.0.0.1:3129" };
  const report = 'printf "%s|%s|%s|%s" "${PI_CODING_AGENT_DIR-unset}" "${EXAMPLE_API_KEY-unset}" "$HTTPS_PROXY" "$NO_PROXY"';

  test("without egress the prefix only removes what the pi process holds for itself", () => {
    expect(piShellCommandPrefix({ unset: ["PI_CODING_AGENT_DIR", "EXAMPLE_API_KEY"] })).toBe("unset PI_CODING_AGENT_DIR EXAMPLE_API_KEY");
  });

  test("a bash command run as pi runs it (prefix, newline, command) loses pi's variables and gets the data-plane proxy", async () => {
    const { file } = await fixture();
    const prefix = piShellCommandPrefix({ unset: [], commandEnvironment: file });
    expect(prefix).toBe(`. '${file}' || exit 126`);
    const result = Bun.spawnSync([bash, "-c", `${prefix}\n${report}`], { env: processEnvironment });
    expect(text(result.stdout)).toBe("unset|unset|http://127.0.0.1:3128|it's");
    expect(result.exitCode).toBe(0);
  });

  test("a command whose environment file is missing never runs", async () => {
    const root = await temporary();
    const marker = path.join(root, "ran");
    const prefix = piShellCommandPrefix({ unset: [], commandEnvironment: path.join(root, "missing") });
    const result = Bun.spawnSync([bash, "-c", `${prefix}\ntouch ${marker}`], { env: processEnvironment });
    expect(result.exitCode).toBe(126);
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("an MCP server started as pi starts it (no shell, pi's environment) gets the same environment and its arguments", async () => {
    const { root, file } = await fixture();
    const server = path.join(root, "server");
    await writeFile(server, `#!/bin/sh\n${report}; printf "|%s|%s" "$1" "$2"\n`, { mode: 0o755 });
    const result = Bun.spawnSync([bash, "-c", PI_MCP_LAUNCH, file, server, "start", "two words"], { env: processEnvironment });
    expect(text(result.stdout)).toBe("unset|unset|http://127.0.0.1:3128|it's|start|two words");
    const missing = Bun.spawnSync([bash, "-c", PI_MCP_LAUNCH, path.join(root, "missing"), server], { env: processEnvironment });
    expect(missing.exitCode).not.toBe(0);
    expect(text(missing.stdout)).toBe("");
  });
});
