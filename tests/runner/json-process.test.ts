import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  RunnerProcessError,
  RunnerProtocolError,
  runProcess,
  runJsonProcess,
} from "../../src/runner/json-process";

const temporaryDirectories: string[] = [];

async function script(source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-runner-"));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, "stage.ts");
  await writeFile(filename, source);
  return filename;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function waitForFile(filename: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await Bun.file(filename).exists()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${filename}`);
}

async function processIsGone(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.split(" ")[2] === "Z";
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) return true;
    throw error;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await processIsGone(pid)) return;
    await Bun.sleep(10);
  }
  throw new Error(`process ${pid} was still running`);
}

async function processGroup(pid: number): Promise<number> {
  const child = Bun.spawn(["ps", "-o", "pgid=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`could not read process group for ${pid}`);
  return Number(stdout.trim());
}

describe("runJsonProcess", () => {
  test("sends JSON input and normalizes the producer result", async () => {
    const filename = await script(`
      const input = await new Response(Bun.stdin.stream()).json();
      console.error("working on " + input.issue.id);
      console.log(JSON.stringify({
        version: 1,
        outcome: "success",
        status: "done",
        summary: "handled " + input.issue.id,
        reason: null,
        metrics: { files: 2 },
        usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 3 },
        cost: { amount: 0.02, currency: "USD", source: "reported" },
        artifacts: [{ name: "report", path: "/tmp/report.json" }]
      }));
    `);

    const result = await runJsonProcess({
      command: [process.execPath, filename],
      cwd: path.dirname(filename),
      input: { issue: { id: "issue-12" } },
    });

    expect(result.stageResult).toEqual({
      outcome: "success",
      status: "done",
      summary: "handled issue-12",
      reason: null,
      metrics: { files: 2 },
    });
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 3,
    });
    expect(result.cost).toEqual({
      amount: 0.02,
      currency: "USD",
      source: "reported",
    });
    expect(result.artifacts).toEqual([
      { name: "report", path: "/tmp/report.json" },
    ]);
    expect(result.stderr).toContain("working on issue-12");
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("uses resolved cwd, path-valued environment, and script context", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-runner-paths-"));
    temporaryDirectories.push(directory);
    const target = path.join(directory, "target");
    const link = path.join(directory, "link");
    await mkdir(path.join(target, "workspace"), { recursive: true });
    await mkdir(path.join(target, "repository"));
    await mkdir(path.join(target, "cache"));
    await symlink(target, link);
    const filename = await script(`
      const input = await new Response(Bun.stdin.stream()).json();
      console.log(JSON.stringify({
        version: 1, outcome: "success", status: "done", summary: "ok", reason: null,
        metrics: { cwd: process.cwd(), cache: process.env.CACHE, workspace: input.workspace.path, repository: input.repository.folder }, artifacts: []
      }));
    `);

    const result = await runJsonProcess({
      command: [process.execPath, filename],
      cwd: path.join(link, "workspace"),
      env: { CACHE: path.join(link, "cache") },
      input: {
        workspace: { path: path.join(link, "workspace") },
        repository: { folder: path.join(link, "repository") },
      },
    });

    expect(result.stageResult.metrics).toEqual({
      cwd: path.join(target, "workspace"),
      cache: path.join(target, "cache"),
      workspace: path.join(target, "workspace"),
      repository: path.join(target, "repository"),
    });
  });

  test("rejects stdout containing anything except one result object", async () => {
    const filename = await script(`
      console.log(JSON.stringify({
        version: 1,
        outcome: "success",
        status: "done",
        summary: "ok",
        reason: null
      }));
      console.log("debug noise");
    `);

    await expect(
      runJsonProcess({
        command: [process.execPath, filename],
        cwd: path.dirname(filename),
        input: {},
      }),
    ).rejects.toBeInstanceOf(RunnerProtocolError);
  });

  test("reports a nonzero exit with captured stderr", async () => {
    const filename = await script(`
      console.error("deploy failed clearly");
      process.exit(7);
    `);

    try {
      await runJsonProcess({
        command: [process.execPath, filename],
        cwd: path.dirname(filename),
        input: {},
      });
      throw new Error("expected process failure");
    } catch (error) {
      expect(error).toBeInstanceOf(RunnerProcessError);
      expect(error).toMatchObject({ exitCode: 7 });
      expect(String(error)).toContain("deploy failed clearly");
    }
  });

  test("terminates a process that exceeds its configured timeout", async () => {
    const filename = await script(`
      await Bun.sleep(10_000);
      console.log("never reached");
    `);

    await expect(
      runJsonProcess({
        command: [process.execPath, filename],
        cwd: path.dirname(filename),
        input: {},
        timeoutMs: 50,
        interruptGraceMs: 10,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  test("starts the command as the leader of its own process group", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-runner-group-"));
    temporaryDirectories.push(directory);
    const pidFile = path.join(directory, "pid");
    const controller = new AbortController();
    const execution = runProcess({
      command: ["sh", "-c", `echo $$ > ${pidFile}; sleep 2`],
      cwd: directory,
      input: {},
      signal: controller.signal,
      interruptGraceMs: 50,
    });

    await waitForFile(pidFile);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(await processGroup(pid)).toBe(pid);

    controller.abort();
    await expect(execution).rejects.toThrow(/interrupted/i);
  });

  test("interrupting a shell stage terminates its background child", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-runner-child-"));
    temporaryDirectories.push(directory);
    const pidFile = path.join(directory, "child-pid");
    const controller = new AbortController();
    const execution = runProcess({
      command: ["sh", "-c", `sleep 2 & echo $! > ${pidFile}; wait`],
      cwd: directory,
      input: {},
      signal: controller.signal,
      interruptGraceMs: 50,
    });

    await waitForFile(pidFile);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    controller.abort();

    await expect(execution).rejects.toThrow(/interrupted/i);
    await waitForProcessExit(pid);
  });

  test("force-kills a SIGTERM-ignoring descendant after the grace period", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-runner-force-kill-"));
    temporaryDirectories.push(directory);
    const pidFile = path.join(directory, "child-pid");
    const controller = new AbortController();
    const graceMs = 50;
    const execution = runProcess({
      command: ["sh", "-c", `(trap '' TERM; sleep 2) & echo $! > ${pidFile}; exit 0`],
      cwd: directory,
      input: {},
      signal: controller.signal,
      interruptGraceMs: graceMs,
    });

    await waitForFile(pidFile);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    const interruptedAt = performance.now();
    controller.abort();

    await expect(execution).rejects.toThrow(/interrupted/i);
    expect(performance.now() - interruptedAt).toBeLessThan(500);
    await waitForProcessExit(pid);
  });

  test("does not wait for a SIGTERM-responsive stdout holder after its parent exits", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-runner-stdout-holder-"));
    temporaryDirectories.push(directory);
    const pidFile = path.join(directory, "child-pid");
    const controller = new AbortController();
    const execution = runProcess({
      command: ["sh", "-c", `sleep 2 2>/dev/null & echo $! > ${pidFile}; exit 0`],
      cwd: directory,
      input: {},
      signal: controller.signal,
      interruptGraceMs: 100,
    });

    await waitForFile(pidFile);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    const interruptedAt = performance.now();
    controller.abort();

    await expect(execution).rejects.toThrow(/interrupted/i);
    expect(performance.now() - interruptedAt).toBeLessThan(500);
    await waitForProcessExit(pid);
  });

  test("times out a shell stage and terminates its background child", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-runner-timeout-child-"));
    temporaryDirectories.push(directory);
    const pidFile = path.join(directory, "child-pid");
    const execution = runProcess({
      command: ["sh", "-c", `sleep 2 & echo $! > ${pidFile}; wait`],
      cwd: directory,
      input: {},
      timeoutMs: 30,
      interruptGraceMs: 50,
    });

    await waitForFile(pidFile);
    const pid = Number((await readFile(pidFile, "utf8")).trim());

    const startedAt = Date.now();
    await expect(execution).rejects.toThrow(/timed out/i);
    expect(Date.now() - startedAt).toBeLessThan(500);
    await waitForProcessExit(pid);
  });

  test("cancels cleanly when the process group already exited", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-runner-gone-group-"));
    temporaryDirectories.push(directory);
    const pidFile = path.join(directory, "child-pid");
    const controller = new AbortController();
    const execution = runProcess({
      command: ["sh", "-c", `setsid sh -c 'sleep 0.1' & echo $! > ${pidFile}; exit 0`],
      cwd: directory,
      input: {},
      signal: controller.signal,
      interruptGraceMs: 50,
    });

    await waitForFile(pidFile);
    await Bun.sleep(20);
    controller.abort();
    await expect(execution).rejects.toThrow(/interrupted/i);
  });

  test("falls back to the direct child when its process group is gone", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-runner-group-fallback-"));
    temporaryDirectories.push(directory);
    const controller = new AbortController();
    const originalKill = process.kill;
    let groupSignals = 0;
    Object.defineProperty(process, "kill", {
      configurable: true,
      value: ((pid: number, signal?: NodeJS.Signals | number): boolean => {
        if (pid < 0) {
          groupSignals += 1;
          throw Object.assign(new Error("group gone"), { code: "ESRCH" });
        }
        return Reflect.apply(originalKill, process, [pid, signal]) as boolean;
      }) as typeof process.kill,
    });
    try {
      const execution = runProcess({
        command: ["sh", "-c", "sleep 2"],
        cwd: directory,
        input: {},
        signal: controller.signal,
        interruptGraceMs: 50,
      });
      controller.abort();

      await expect(execution).rejects.toThrow(/interrupted/i);
      expect(groupSignals).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(process, "kill", { configurable: true, value: originalKill });
    }
  });

  test("force-kills a stderr-holding descendant after its direct parent exits", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-runner-stderr-holder-"));
    temporaryDirectories.push(directory);
    const pidFile = path.join(directory, "child-pid");
    const controller = new AbortController();
    const execution = runProcess({
      command: ["sh", "-c", `(trap '' TERM; sleep 2) >/dev/null & echo $! > ${pidFile}; exit 0`],
      cwd: directory,
      input: {},
      signal: controller.signal,
      interruptGraceMs: 50,
    });

    await waitForFile(pidFile);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    const interruptedAt = performance.now();
    controller.abort();

    await expect(execution).rejects.toThrow(/interrupted/i);
    expect(performance.now() - interruptedAt).toBeLessThan(500);
    await waitForProcessExit(pid);
  });

  test("accepts result with omitted metrics field", async () => {
    const filename = await script(`
      console.log(JSON.stringify({
        version: 1,
        outcome: "success",
        status: "done",
        summary: "handled without metrics",
        reason: null,
        artifacts: []
      }));
    `);

    const result = await runJsonProcess({
      command: [process.execPath, filename],
      cwd: path.dirname(filename),
      input: {},
    });

    expect(result.stageResult).toEqual({
      outcome: "success",
      status: "done",
      summary: "handled without metrics",
      reason: null,
      metrics: {},
    });
    expect(result.exitCode).toBe(0);
  });

  test("accepts result with empty metrics object", async () => {
    const filename = await script(`
      console.log(JSON.stringify({
        version: 1,
        outcome: "success",
        status: "done",
        summary: "handled with empty metrics",
        reason: null,
        metrics: {},
        artifacts: []
      }));
    `);

    const result = await runJsonProcess({
      command: [process.execPath, filename],
      cwd: path.dirname(filename),
      input: {},
    });

    expect(result.stageResult).toEqual({
      outcome: "success",
      status: "done",
      summary: "handled with empty metrics",
      reason: null,
      metrics: {},
    });
    expect(result.exitCode).toBe(0);
  });
});
