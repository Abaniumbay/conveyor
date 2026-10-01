import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCodex } from "../../src/runner/codex";
import { runCodexCheck } from "../../src/runner/codex-check";
import { runCodexSteering } from "../../src/runner/codex-steering";

const directories: string[] = [];
const saved = { ...process.env };

beforeEach(() => {
  Object.assign(process.env, {
    GH_TOKEN: "gh-secret",
    GITHUB_TOKEN: "gh-secret",
    SSH_AUTH_SOCK: "/run/ssh",
    GIT_ASKPASS: "/bin/ask",
    CONVEYOR_CONFIG: "/etc/conveyor",
    OPENAI_API_KEY: "sk-secret",
  });
  delete process.env.CODEX_HOME;
});
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-agent-env-"));
  directories.push(directory);
  const workspace = path.join(directory, "workspace");
  const artifacts = path.join(directory, "artifacts", "run-1");
  const executable = path.join(directory, "fake-codex");
  const capture = path.join(directory, "env.json");
  await mkdir(workspace);
  await mkdir(artifacts, { recursive: true });
  await writeFile(executable, `#!/usr/bin/env bun
    const args = process.argv.slice(2);
    await new Response(Bun.stdin.stream()).text();
    await Bun.write(process.env.ENV_CAPTURE, JSON.stringify(process.env));
    const output = args[args.indexOf("-o") + 1];
    if (output && process.env.KIND === "run") await Bun.write(output, JSON.stringify({ version: 1, outcome: "success", status: "done", summary: "s", reason: null, metrics: {}, artifacts: [] }));
    if (output && process.env.KIND === "check") await Bun.write(output, JSON.stringify({ version: 1, decision: "pass", status: "done", reason: "ok", evidence: [], requiredFixes: [], criteria: [] }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }));
  `);
  await chmod(executable, 0o755);
  return { workspace, artifacts, executable, capture };
}

type Captured = Record<string, string | undefined>;

async function expectCredentialFree(files: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const env = JSON.parse(await readFile(files.capture, "utf8")) as Captured;
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "GIT_ASKPASS", "CONVEYOR_CONFIG", "OPENAI_API_KEY", "LEAK_TOKEN"]) {
    expect(env[name]).toBeUndefined();
  }
  expect(env.HOME).toBe(path.join(files.artifacts, "home"));
  expect(env.CODEX_HOME).toBe(path.join(saved.HOME!, ".codex"));
  expect(env.ENV_CAPTURE).toBe(files.capture);
  expect(await readdir(env.HOME!)).toEqual([".gitconfig"]);
}

const common = {
  prompt: "go",
  sandbox: "workspace-write" as const,
  automaticApprovals: true,
  mcp: { command: "bun", args: ["mcp.ts"] },
};

describe("agent environment", () => {
  test("runCodex spawns with a sanitized environment", async () => {
    const files = await fixture();
    await runCodex({
      ...common,
      command: files.executable,
      workspace: files.workspace,
      artifactsDirectory: files.artifacts,
      env: { ENV_CAPTURE: files.capture, KIND: "run", LEAK_TOKEN: "x" },
    });
    await expectCredentialFree(files);
  });

  test("runCodexCheck spawns with a sanitized environment", async () => {
    const files = await fixture();
    await runCodexCheck({
      ...common,
      command: files.executable,
      workspace: files.workspace,
      artifactsDirectory: files.artifacts,
      env: { ENV_CAPTURE: files.capture, KIND: "check", LEAK_TOKEN: "x" },
    });
    await expectCredentialFree(files);
  });

  test("runCodexSteering spawns with a sanitized environment", async () => {
    const files = await fixture();
    await runCodexSteering({
      ...common,
      command: files.executable,
      workspace: files.workspace,
      artifactsDirectory: files.artifacts,
      env: { ENV_CAPTURE: files.capture, KIND: "steer", LEAK_TOKEN: "x" },
    });
    await expectCredentialFree(files);
  });
});
