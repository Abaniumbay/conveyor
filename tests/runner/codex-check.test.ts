import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CodexRunnerError } from "../../src/runner/codex";
import { checkResultSchema, runCodexCheck } from "../../src/runner/codex-check";

const temporaryDirectories: string[] = [];

async function fixture(source: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-codex-check-"));
  temporaryDirectories.push(directory);
  const workspace = path.join(directory, "workspace");
  const artifacts = path.join(directory, "artifacts");
  const executable = path.join(directory, "fake-codex");
  const capture = path.join(directory, "capture.json");
  await mkdir(workspace);
  await mkdir(artifacts);
  await writeFile(executable, `#!/usr/bin/env bun\n${source}`);
  await chmod(executable, 0o755);
  return { directory, workspace, artifacts, executable, capture };
}

async function waitForCapturedPaths(capture: string): Promise<{ tmpdir: string; home: string }> {
  for (let attempts = 0; !existsSync(capture) && attempts < 100; attempts += 1) await Bun.sleep(10);
  if (!existsSync(capture)) throw new Error("fake Codex did not record its disposable paths");
  return JSON.parse(await readFile(capture, "utf8")) as { tmpdir: string; home: string };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("runCodexCheck", () => {
  test("uses an output schema accepted by the Codex structured-output API", async () => {
    const files = await fixture(`
      const args = process.argv.slice(2);
      const schemaPath = args[args.indexOf("--output-schema") + 1];
      const schema = await Bun.file(schemaPath).json();
      if (schema.allOf !== undefined) {
        console.error("structured outputs do not accept allOf");
        process.exit(1);
      }
      if (schema.properties?.version?.type !== "integer") {
        console.error("structured-output properties require explicit types");
        process.exit(1);
      }
      const output = args[args.indexOf("-o") + 1];
      await Bun.write(output, JSON.stringify({
        version: 1,
        decision: "pass",
        status: "ready",
        reason: null,
        evidence: ["Issue has acceptance criteria."],
        requiredFixes: [],
        criteria: []
      }));
    `);

    await expect(runCodexCheck({
      command: files.executable,
      workspace: files.workspace,
      artifactsDirectory: files.artifacts,
      prompt: "Check",
      sandbox: "read-only",
      automaticApprovals: false,
      mcp: { command: "bun", args: [] },
    })).resolves.toMatchObject({ decision: "pass", status: "ready" });
  });

  test("allows a structured human question to pause without invented fixes", () => {
    expect(checkResultSchema.safeParse({
      version: 1,
      decision: "fail",
      status: "needs-input",
      reason: "A product choice is required.",
      evidence: [],
      requiredFixes: [],
      criteria: [],
    }).success).toBe(true);
  });

  test("executes a non-interactive verifier and returns validated decision and telemetry", async () => {
    const files = await fixture(`
      const args = process.argv.slice(2);
      const prompt = await new Response(Bun.stdin.stream()).text();
      await Bun.write(process.env.CAPTURE!, JSON.stringify({ args, prompt }));
      const output = args[args.indexOf("-o") + 1];
      await Bun.write(output, JSON.stringify({
        version: 1,
        decision: "fail",
        status: "blocked",
        reason: "The empty state is missing.",
        evidence: ["src/empty.tsx"],
        requiredFixes: ["Implement the empty state."],
        criteria: [{ id: "AC-1", passed: false, evidence: "No empty-state test" }]
      }));
      console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-check-1" }));
      console.log(JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 120, cached_input_tokens: 50, output_tokens: 30 }
      }));
    `);

    const result = await runCodexCheck({
      command: files.executable,
      workspace: files.workspace,
      artifactsDirectory: files.artifacts,
      prompt: "Evaluate the current issue and workspace.",
      model: "gpt-test",
      effort: "high",
      sandbox: "read-only",
      automaticApprovals: true,
      mcp: { command: "bun", args: ["run", "/opt/conveyor/mcp.ts"] },
      env: { CAPTURE: files.capture, SECRET_SHOULD_NOT_LEAK: "no" },
    });

    expect(result).toMatchObject({
      decision: "fail",
      status: "blocked",
      reason: "The empty state is missing.",
      evidence: ["src/empty.tsx"],
      requiredFixes: ["Implement the empty state."],
      criteria: [{ id: "AC-1", passed: false, evidence: "No empty-state test" }],
      sessionId: "thread-check-1",
      usage: { inputTokens: 120, outputTokens: 30, cachedTokens: 50 },
      exitCode: 0,
      stderr: "",
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const invocation = JSON.parse(await readFile(files.capture, "utf8")) as {
      args: string[];
      prompt: string;
    };
    expect(invocation.prompt).toBe("Evaluate the current issue and workspace.");
    expect(invocation.args).toContain("--json");
    expect(invocation.args).toContain("--output-schema");
    expect(invocation.args).not.toContain("--approve-for-me");
    expect(invocation.args).not.toContain("--full-auto");
    expect(invocation.args).toContain('mcp_servers.conveyor.required=true');
    expect(invocation.args).toContain(
      'mcp_servers.conveyor.default_tools_approval_mode="approve"',
    );
  });

  test("gives write-capable checks their item scratch directory", async () => {
    const files = await fixture(`
      const args = process.argv.slice(2);
      await Bun.write(process.env.TMPDIR + "/check-marker", "preserved");
      await Bun.write(process.env.CAPTURE!, JSON.stringify({ args, tmpdir: process.env.TMPDIR }));
      await Bun.write(args[args.indexOf("-o") + 1], JSON.stringify({
        version: 1, decision: "pass", status: "done", reason: null, evidence: [], requiredFixes: [], criteria: []
      }));
    `);
    const scratch = path.join(files.directory, "workspace.tmp");
    await mkdir(scratch);

    await runCodexCheck({
      command: files.executable, workspace: files.workspace, artifactsDirectory: files.artifacts,
      prompt: "Review", sandbox: "workspace-write", automaticApprovals: true,
      mcp: { command: "bun", args: [] }, env: { CAPTURE: files.capture }, temporaryDirectory: scratch,
    });

    const captured = JSON.parse(await readFile(files.capture, "utf8")) as { args: string[]; tmpdir: string };
    expect(captured.tmpdir).toBe(scratch);
    expect(await readFile(path.join(scratch, "check-marker"), "utf8")).toBe("preserved");
    expect(captured.args).toContain("sandbox_workspace_write.exclude_slash_tmp=true");
    const roots = JSON.parse(captured.args.find((arg) => arg.startsWith("sandbox_workspace_write.writable_roots="))!.split("=")[1]!) as string[];
    expect(roots).toContain(scratch);
  });

  test("classifies usage-limit failures", async () => {
    const files = await fixture(`
      console.error("You have hit your usage limit. Try again later.");
      process.exit(1);
    `);

    await expect(runCodexCheck({
      command: files.executable,
      workspace: files.workspace,
      artifactsDirectory: files.artifacts,
      prompt: "Check",
      sandbox: "read-only",
      automaticApprovals: false,
      mcp: { command: "bun", args: ["mcp.ts"] },
    })).rejects.toMatchObject({
      kind: "usage-limit",
      exitCode: 1,
      stderr: "You have hit your usage limit. Try again later.\n",
    });
  });

  test("classifies process, timeout, and interruption failures", async () => {
    const failing = await fixture(`
      console.error("could not connect to the Codex service");
      process.exit(2);
    `);
    await expect(runCodexCheck({
      command: failing.executable,
      workspace: failing.workspace,
      artifactsDirectory: failing.artifacts,
      prompt: "Check",
      sandbox: "read-only",
      automaticApprovals: false,
      mcp: { command: "bun", args: [] },
    })).rejects.toMatchObject({ kind: "process", exitCode: 2 });

    const slow = await fixture(`
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    `);
    const input = {
      command: slow.executable,
      workspace: slow.workspace,
      artifactsDirectory: slow.artifacts,
      prompt: "Check",
      sandbox: "read-only" as const,
      automaticApprovals: false,
      mcp: { command: "bun", args: [] },
      interruptGraceMs: 20,
    };
    await expect(runCodexCheck({ ...input, timeoutMs: 20 })).rejects.toMatchObject({
      kind: "timeout",
    });

    const controller = new AbortController();
    const interrupted = runCodexCheck({ ...input, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(interrupted).rejects.toMatchObject({ kind: "interrupted" });
  });

  test("cleans disposable scratch and private homes after failure, timeout, and interruption", async () => {
    const failed = await fixture(`
      await Bun.write(process.env.CAPTURE!, JSON.stringify({ tmpdir: process.env.TMPDIR, home: process.env.HOME }));
      process.exit(2);
    `);
    const base = (files: Awaited<ReturnType<typeof fixture>>) => ({
      command: files.executable, workspace: files.workspace, artifactsDirectory: files.artifacts,
      prompt: "Check", sandbox: "read-only" as const, automaticApprovals: false,
      mcp: { command: "bun", args: [] }, env: { CAPTURE: files.capture },
    });
    await expect(runCodexCheck(base(failed))).rejects.toMatchObject({ kind: "process" });
    const failedPaths = JSON.parse(await readFile(failed.capture, "utf8")) as { tmpdir: string; home: string };
    expect(existsSync(failedPaths.tmpdir)).toBe(false);
    expect(existsSync(failedPaths.home)).toBe(false);

    const slow = await fixture(`
      await Bun.write(process.env.CAPTURE!, JSON.stringify({ tmpdir: process.env.TMPDIR, home: process.env.HOME }));
      await Bun.sleep(2_000);
    `);
    const timeout = runCodexCheck({ ...base(slow), timeoutMs: 1_000 });
    const timeoutPaths = await waitForCapturedPaths(slow.capture);
    expect(existsSync(timeoutPaths.tmpdir)).toBe(true);
    expect(existsSync(timeoutPaths.home)).toBe(true);
    await expect(timeout).rejects.toMatchObject({ kind: "timeout" });
    expect(existsSync(timeoutPaths.tmpdir)).toBe(false);
    expect(existsSync(timeoutPaths.home)).toBe(false);

    const interrupted = await fixture(`
      await Bun.write(process.env.CAPTURE!, JSON.stringify({ tmpdir: process.env.TMPDIR, home: process.env.HOME }));
      await Bun.sleep(2_000);
    `);
    const controller = new AbortController();
    const run = runCodexCheck({ ...base(interrupted), signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(run).rejects.toMatchObject({ kind: "interrupted" });
    const interruptedPaths = JSON.parse(await readFile(interrupted.capture, "utf8")) as { tmpdir: string; home: string };
    expect(existsSync(interruptedPaths.tmpdir)).toBe(false);
    expect(existsSync(interruptedPaths.home)).toBe(false);
  });

  test("rejects invalid verifier protocol output", async () => {
    const files = await fixture(`
      const args = process.argv.slice(2);
      await Bun.write(args[args.indexOf("-o") + 1], JSON.stringify({
        version: 1, decision: "pass", status: "done", reason: null,
        evidence: [], requiredFixes: [], criteria: [{ id: "AC-1", passed: true }]
      }));
    `);

    await expect(runCodexCheck({
      command: files.executable,
      workspace: files.workspace,
      artifactsDirectory: files.artifacts,
      prompt: "Check",
      sandbox: "read-only",
      automaticApprovals: false,
      mcp: { command: "bun", args: [] },
    })).rejects.toBeInstanceOf(CodexRunnerError);
    await expect(runCodexCheck({
      command: files.executable,
      workspace: files.workspace,
      artifactsDirectory: files.artifacts,
      prompt: "Check",
      sandbox: "read-only",
      automaticApprovals: false,
      mcp: { command: "bun", args: [] },
    })).rejects.toMatchObject({ kind: "protocol", exitCode: 0 });
  });
});
