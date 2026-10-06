import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { captureOutput } from "../../src/engine/stage-context";
import { createTaskRegistry } from "../../src/tasks/catalogue";
import type { ScriptContext, TaskContext } from "../../src/tasks/context";
import { runTask, TaskConfigError, type TaskResult } from "../../src/tasks/contract";
import type { TaskDeps } from "../../src/tasks/deps";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const registry = createTaskRegistry();
const SCRIPT = path.join(import.meta.dir, "../fixtures/scripts/recovering.ts");
const success = (summary = "done") => ({ version: 1, outcome: "success", status: "deployed", summary, reason: null });
const failure = { version: 1, outcome: "failure", status: "broken", summary: "it broke", reason: "boom" };

async function world(control: Record<string, unknown>) {
  const folder = await mkdtemp(path.join(tmpdir(), "conveyor-script-"));
  directories.push(folder);
  await writeFile(path.join(folder, "control.json"), JSON.stringify(control));
  const deps = {
    store: { getIssue: () => ({ id: "i1", sourceNumber: 7 }), getActiveWorkspace: () => null },
    config: { settings: { interruptGraceMs: 100 } },
    repository: { id: "repo", address: "o/r", folder, baseBranch: "main" },
    issueId: "i1",
  } as unknown as TaskDeps;
  const context = {
    repository: { ...deps.repository, ciMode: "disabled", systemLabels: [] },
    run: { stage: "deploy", attempt: 1, taskInstanceId: "deploy", feedback: null },
  } as unknown as Partial<TaskContext>;
  const calls = async () =>
    (await readFile(path.join(folder, "calls.log"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const run = (recovery: string, resumed: boolean) =>
    runTask(registry.require("script.run"), {
      context, deps, config: { script: SCRIPT, recovery },
      instance: { id: "deploy", stage: "deploy", idempotencyKey: "key-1", resumed },
    });
  return { run, calls, folder };
}
type Pass = Extract<TaskResult, { status: "pass" }>;
const output = (r: TaskResult) => (r as Pass).output as ScriptContext["results"][string];

describe("script.run", () => {
  test("requires recovery and names both values", async () => {
    const w = await world({});
    const def = registry.require("script.run");
    const go = (config: unknown) => runTask(def, { context: {}, deps: undefined as never, config, instance: { id: "x", stage: "s", idempotencyKey: "k", resumed: false } });
    await expect(go({ script: SCRIPT })).rejects.toThrow(TaskConfigError);
    await expect(go({ script: SCRIPT })).rejects.toThrow(/replay-safe.*reconcile/s);
  });

  test("replay-safe applies every time, even when resumed, and passes the protocol on stdin", async () => {
    const w = await world({ apply: { ...success("deployed it"), externalOperationId: "op-1", artifactUrl: "https://x/a" } });
    const first = output(await w.run("replay-safe", false));
    await w.run("replay-safe", true);
    const calls = await w.calls();
    expect(calls.map((c) => c.phase)).toEqual(["apply", "apply"]);
    expect(calls[0]).toMatchObject({
      phase: "apply", idempotencyKey: "key-1", taskInstanceId: "deploy",
      issue: { id: "i1", sourceNumber: 7 }, workspace: null, stageId: "deploy",
      repository: { id: "repo", folder: w.folder, baseBranch: "main" },
      context: { run: { stage: "deploy" } },
    });
    expect(first).toMatchObject({
      passed: true, recovery: "replay-safe", externalOperationId: "op-1", summary: "deployed it", artifactUrl: "https://x/a",
    });
    expect(first.outputTail).toContain("deployed it");
    expect(Number.isNaN(Date.parse(first.finishedAt))).toBe(false);
  });

  test("an interpreter runs a non-Bun script under the same protocol", async () => {
    const w = await world({});
    const script = path.join(w.folder, "deploy.py");
    await writeFile(script, [
      "import json, sys",
      "request = json.load(sys.stdin)",
      'print(json.dumps({"outcome": "success", "summary": "python " + request["phase"] + " " + request["idempotencyKey"]}))',
      "",
    ].join("\n"));
    const deps = {
      store: { getIssue: () => ({ id: "i1" }), getActiveWorkspace: () => null },
      config: { settings: { interruptGraceMs: 100 } },
      repository: { id: "repo", address: "o/r", folder: w.folder, baseBranch: "main" },
      issueId: "i1",
    } as unknown as TaskDeps;
    const result = await runTask(registry.require("script.run"), {
      context: {}, deps,
      config: { script, recovery: "replay-safe", interpreter: ["python3"] },
      instance: { id: "deploy", stage: "deploy", idempotencyKey: "key-9", resumed: false },
    });
    expect(output(result)).toMatchObject({ passed: true, summary: "python apply key-9" });
  });

  test("reconcile applies on the first run without observing", async () => {
    const w = await world({ apply: success() });
    const result = output(await w.run("reconcile", false));
    expect((await w.calls()).map((c) => c.phase)).toEqual(["apply"]);
    expect(result).toMatchObject({ passed: true, recovery: "reconcile", externalOperationId: null, artifactUrl: null });
  });

  test("reconcile resumed with already-applied records the observed result and does not apply", async () => {
    const w = await world({ observe: { state: "already-applied", operationId: "op-9", result: success("earlier run did it") } });
    const result = output(await w.run("reconcile", true));
    expect((await w.calls()).map((c) => c.phase)).toEqual(["observe"]);
    expect(result).toMatchObject({ passed: true, recovery: "reconcile", externalOperationId: "op-9", summary: "earlier run did it" });
  });

  test("reconcile resumed with not-applied applies exactly once", async () => {
    const w = await world({ observe: { state: "not-applied" }, apply: success() });
    const result = output(await w.run("reconcile", true));
    expect((await w.calls()).map((c) => c.phase)).toEqual(["observe", "apply"]);
    expect(result.passed).toBe(true);
  });

  test("reconcile resumed with indeterminate stops for intervention without applying", async () => {
    const w = await world({ observe: { state: "indeterminate", reason: "cannot tell" }, apply: success() });
    const result = await w.run("reconcile", true);
    expect(result).toEqual({ status: "fail", message: "cannot tell", route: { stop: "needs-intervention" } });
    expect((await w.calls()).map((c) => c.phase)).toEqual(["observe"]);
  });

  test("an invalid observe output is an infrastructure error", async () => {
    const w = await world({ observe: { state: "maybe" } });
    await expect(w.run("reconcile", true)).rejects.toThrow(/observe/);
    expect((await w.calls()).map((c) => c.phase)).toEqual(["observe"]);
  });

  test("a script that reports failure still completes the task; script.succeeded then fails", async () => {
    const w = await world({ apply: failure });
    const result = await w.run("replay-safe", false);
    expect(result.status).toBe("pass");
    expect(output(result)).toMatchObject({ passed: false, summary: "it broke" });
    const check = await runTask(registry.require("script.succeeded"), {
      context: { script: { results: { deploy: output(result) } } }, deps: undefined as never, config: { run: "deploy" },
      instance: { id: "ok", stage: "deploy", idempotencyKey: "", resumed: false },
    });
    expect(check).toMatchObject({ status: "fail", message: "boom" });
    expect((check as { details: string }).details).toContain("boom");
  });

  test("keeps the concrete failure reason even when it falls outside the output tail", async () => {
    const w = await world({ apply: { ...failure, metrics: { big: "x".repeat(10_000) } } });
    const result = output(await w.run("replay-safe", false));
    expect(result.reason).toBe("boom");
    expect(result.outputTail).not.toContain("boom");
    const check = await runTask(registry.require("script.succeeded"), {
      context: { script: { results: { deploy: result } } }, deps: undefined as never, config: { run: "deploy" },
      instance: { id: "ok", stage: "deploy", idempotencyKey: "", resumed: false },
    });
    expect(check).toMatchObject({ status: "fail", message: "boom" });
  });

  test("bounds the output tail to 4 KB", async () => {
    const w = await world({ apply: { ...success(), metrics: { big: "x".repeat(10_000) } } });
    const result = output(await w.run("replay-safe", false));
    expect(Buffer.byteLength(result.outputTail)).toBeLessThanOrEqual(4096);
  });

  test("a script that does not exit cleanly is an infrastructure error", async () => {
    const w = await world({});
    await expect(w.run("replay-safe", false)).rejects.toThrow();
  });
});

describe("script.succeeded", () => {
  const check = (context: Partial<TaskContext>, run = "deploy") =>
    runTask(registry.require("script.succeeded"), {
      context, deps: undefined as never, config: { run },
      instance: { id: "ok", stage: "deploy", idempotencyKey: "", resumed: false },
    });
  const entry = (passed: boolean): ScriptContext["results"][string] => ({
    passed, recovery: "replay-safe", externalOperationId: null, summary: "s", artifactUrl: null, outputTail: "tail", finishedAt: "t",
  });

  test("passes when the named result passed", async () => {
    expect(await check({ script: { results: { deploy: entry(true) } } })).toEqual({ status: "pass" });
  });
  test("fails with the summary and tail when it did not, and when there is no result", async () => {
    expect(await check({ script: { results: { deploy: entry(false) } } })).toEqual({ status: "fail", message: "s", details: "tail" });
    expect((await check({ script: { results: {} } })).status).toBe("fail");
  });
  test("falls back to the summary for absent or blank reasons in stored results", async () => {
    for (const reason of [undefined, null, "   "]) {
      const result = { ...entry(false), ...(reason === undefined ? {} : { reason }) };
      expect(await check({ script: { results: { deploy: result } } })).toMatchObject({ status: "fail", message: "s" });
    }
  });
  test("reads only its named instance", async () => {
    expect((await check({ script: { results: { a: entry(true), b: entry(false) } } }, "b")).status).toBe("fail");
  });
});

describe("captured script key", () => {
  test("merges results by instance id and keeps the other instances", () => {
    const context = { script: { results: { a: { passed: true } } } } as unknown as TaskContext;
    captureOutput(context, { id: "b", writes: ["script"] }, { passed: false });
    captureOutput(context, { id: "a", writes: ["script"] }, { passed: false });
    expect(context.script as unknown).toEqual({ results: { a: { passed: false }, b: { passed: false } } });
  });
});
