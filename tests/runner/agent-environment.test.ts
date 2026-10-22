import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveFilesystemPath } from "../../src/core/paths";
import { runCodex } from "../../src/runner/codex";
import { runCodexCheck } from "../../src/runner/codex-check";
import { runCodexSteering } from "../../src/runner/codex-steering";
import { bwrapUnavailableReason } from "../support/bwrap";

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
    await Bun.write(process.env.ENV_CAPTURE, JSON.stringify({ ...process.env, TMP_EXISTED: String(require("node:fs").existsSync(process.env.TMPDIR)), RUN_ARGS: JSON.stringify(args), RUN_CWD: process.cwd() }));
    if (process.env.LOCK_HOME === "true" && process.env.KIND === "wait") {
      await require("node:fs/promises").chmod(require("node:path").dirname(process.env.HOME), 0o500);
      await Bun.write(process.env.LOCK_READY, "locked");
    }
    if (process.env.KIND === "fail") process.exit(3);
    if (process.env.KIND === "wait") await Bun.sleep(2_000);
    const output = args[args.indexOf("-o") + 1];
    if (output && process.env.KIND === "run") await Bun.write(output, JSON.stringify({ version: 1, outcome: "success", status: "done", summary: "s", reason: null, metrics: {}, artifacts: [] }));
    if (output && process.env.KIND === "check") await Bun.write(output, JSON.stringify({ version: 1, decision: "pass", status: "done", reason: "ok", evidence: [], requiredFixes: [], criteria: [] }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }));
    if (process.env.LOCK_HOME === "true" && process.env.KIND !== "wait") await require("node:fs/promises").chmod(require("node:path").dirname(process.env.HOME), 0o500);
  `);
  await chmod(executable, 0o755);
  return { directory, workspace, artifacts, executable, capture };
}

type Captured = Record<string, string | undefined>;

async function expectCredentialFree(files: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const env = JSON.parse(await readFile(files.capture, "utf8")) as Captured;
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "GIT_ASKPASS", "CONVEYOR_CONFIG", "OPENAI_API_KEY", "LEAK_TOKEN"]) {
    expect(env[name]).toBeUndefined();
  }
  expect(env.HOME).toBe(path.join(files.artifacts, "home"));
  expect(env.CODEX_HOME).toBe(resolveFilesystemPath(path.join(saved.HOME!, ".codex")));
  expect(env.ENV_CAPTURE).toBe(files.capture);
  expect(existsSync(env.HOME!)).toBe(false);
}

const common = {
  prompt: "go",
  sandbox: "workspace-write" as const,
  automaticApprovals: true,
  mcp: { command: "bun", args: ["mcp.ts"] },
};

const unavailable = bwrapUnavailableReason();
if (unavailable) console.warn(`SKIPPED agent environment Codex tests: \`bwrap\` is unavailable (${unavailable})`);
const describeSandbox = unavailable ? describe.skip : describe;

describeSandbox("agent environment", () => {
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

  test("runCodex gives a run its own temp directory and removes it afterwards, also when the run fails", async () => {
    for (const kind of ["run", "fail"]) {
      const files = await fixture();
      const run = runCodex({
        ...common, command: files.executable, workspace: files.workspace, artifactsDirectory: files.artifacts,
        env: { ENV_CAPTURE: files.capture, KIND: kind },
      });
      if (kind === "fail") await expect(run).rejects.toThrow();
      else await run;
      const env = JSON.parse(await readFile(files.capture, "utf8")) as Captured;
      expect(path.dirname(env.TMPDIR!)).toBe(tmpdir());
      expect(path.basename(env.TMPDIR!)).toStartWith("conveyor-run-");
      expect(env.TMP_EXISTED).toBe("true");
      expect(existsSync(env.TMPDIR!)).toBe(false);
      expect(existsSync(env.HOME!)).toBe(false);
    }
  });

  test("keeps an active run home until an interrupted process exits", async () => {
    const files = await fixture();
    const controller = new AbortController();
    const run = runCodex({
      ...common, command: files.executable, workspace: files.workspace, artifactsDirectory: files.artifacts,
      env: { ENV_CAPTURE: files.capture, KIND: "wait" }, signal: controller.signal, interruptGraceMs: 20,
    });
    for (let attempts = 0; !existsSync(files.capture) && attempts < 20; attempts += 1) await Bun.sleep(10);
    const env = JSON.parse(await readFile(files.capture, "utf8")) as Captured;
    expect(existsSync(env.HOME!)).toBe(true);

    controller.abort();
    await expect(run).rejects.toMatchObject({ kind: "interrupted" });
    expect(existsSync(env.HOME!)).toBe(false);
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

  test("retains Codex results and events when private-home cleanup fails", async () => {
    for (const kind of ["run", "check", "steer"] as const) {
      const files = await fixture();
      const events: unknown[] = [];
      let cleanupError: string | undefined;
      try {
        const input = {
          ...common,
          command: files.executable,
          workspace: files.workspace,
          artifactsDirectory: files.artifacts,
          env: { ENV_CAPTURE: files.capture, KIND: kind, LOCK_HOME: "true" },
          onEvent: (event: unknown) => events.push(event),
        };
        if (kind === "run") {
          const result = await runCodex(input);
          cleanupError = result.cleanupError;
          expect(result.stageResult.summary).toBe("s");
        } else if (kind === "check") {
          const result = await runCodexCheck(input);
          cleanupError = result.cleanupError;
          expect(result.decision).toBe("pass");
        } else {
          const result = await runCodexSteering(input);
          cleanupError = result.cleanupError;
          expect(result.summary).toBe("done");
        }
      } finally {
        await chmod(files.artifacts, 0o700);
      }
      const env = JSON.parse(await readFile(files.capture, "utf8")) as Captured;
      expect(cleanupError).toContain("private home");
      expect(events).toContainEqual(expect.objectContaining({ type: "item.completed" }));
      expect(existsSync(env.HOME!)).toBe(true);
      if (kind !== "steer") expect((await readdir(files.artifacts)).some((entry) => entry.startsWith("codex-"))).toBe(true);
    }
  });

  test("runCodexSteering cleans homes after failure and interruption", async () => {
    for (const [kind, expectedKind] of [["fail", "process"], ["wait", "interrupted"]] as const) {
      const files = await fixture();
      const controller = new AbortController();
      const run = runCodexSteering({
        ...common,
        command: files.executable,
        workspace: files.workspace,
        artifactsDirectory: files.artifacts,
        env: { ENV_CAPTURE: files.capture, KIND: kind },
        ...(kind === "wait" ? { signal: controller.signal, interruptGraceMs: 20 } : {}),
      });
      if (kind === "wait") {
        for (let attempts = 0; !existsSync(files.capture) && attempts < 20; attempts += 1) await Bun.sleep(10);
        controller.abort();
      }
      await expect(run).rejects.toMatchObject({ kind: expectedKind });
      const env = JSON.parse(await readFile(files.capture, "utf8")) as Captured;
      expect(existsSync(env.HOME!)).toBe(false);
    }
  });

  test("preserves interruption errors when private-home cleanup fails", async () => {
    for (const kind of ["run", "check", "steer"] as const) {
      const files = await fixture();
      const controller = new AbortController();
      const lockReady = path.join(files.directory, "home-locked");
      const input = {
        ...common,
        command: files.executable,
        workspace: files.workspace,
        artifactsDirectory: files.artifacts,
        env: { ENV_CAPTURE: files.capture, KIND: "wait", LOCK_HOME: "true", LOCK_READY: lockReady },
        signal: controller.signal,
        interruptGraceMs: 20,
      };
      const run = kind === "run"
        ? runCodex(input)
        : kind === "check"
          ? runCodexCheck(input)
          : runCodexSteering(input);
      for (let attempts = 0; !existsSync(lockReady) && attempts < 20; attempts += 1) await Bun.sleep(10);
      expect(existsSync(lockReady)).toBe(true);
      controller.abort();
      try {
        await expect(run).rejects.toMatchObject({ kind: "interrupted", cleanupError: expect.stringContaining("private home") });
      } finally {
        await chmod(files.artifacts, 0o700);
      }
      const env = JSON.parse(await readFile(files.capture, "utf8")) as Captured;
      expect(existsSync(env.HOME!)).toBe(true);
    }
  });

  test("Codex producer, check, and steering consume only resolved launch paths", async () => {
    for (const kind of ["run", "check", "steer"] as const) {
      const files = await fixture();
      const link = path.join(files.directory, "link");
      const allowedRoot = path.join(files.directory, "allowed-root");
      await symlink(files.directory, link);
      await symlink(path.join(process.cwd(), "src"), allowedRoot);
      const linked = {
        workspace: path.join(link, "workspace"),
        artifactsDirectory: path.join(link, "artifacts", "run-1"),
        temporaryDirectory: path.join(link, "scratch"),
        writableRoots: [allowedRoot, path.join(link, "missing")],
        env: { ENV_CAPTURE: path.join(link, "env.json"), KIND: kind },
      };
      if (kind === "run") await runCodex({ ...common, command: files.executable, ...linked });
      else if (kind === "check") await runCodexCheck({ ...common, command: files.executable, ...linked });
      else await runCodexSteering({ ...common, command: files.executable, ...linked });

      const env = JSON.parse(await readFile(files.capture, "utf8")) as Captured;
      expect(env.RUN_CWD).toBe(resolveFilesystemPath(files.workspace));
      expect(env.HOME).toBe(resolveFilesystemPath(path.join(files.artifacts, "home")));
      expect(env.TMPDIR).toBe(resolveFilesystemPath(path.join(files.directory, "scratch")));
      expect(env.ENV_CAPTURE).toBe(resolveFilesystemPath(files.capture));
      expect(env.RUN_ARGS).not.toContain(link);
      expect(env.RUN_ARGS).not.toContain(allowedRoot);
      expect(env.RUN_ARGS).toContain(resolveFilesystemPath(allowedRoot));
    }
  });
});
