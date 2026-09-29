import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  RunnerProcessError,
  RunnerProtocolError,
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
});
