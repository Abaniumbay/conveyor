import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { codexHarness } from "../../src/harness/codex";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("codexHarness", () => {
  test("advertises session resume and drives `codex exec resume` with a persisted session", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "conveyor-harness-"));
    directories.push(directory);
    const executable = path.join(directory, "fake-codex");
    const capture = path.join(directory, "capture.json");
    await mkdir(path.join(directory, "workspace"));
    await writeFile(executable, `#!/usr/bin/env bun
      const args = process.argv.slice(2);
      await Bun.write(process.env.CAPTURE!, JSON.stringify(args));
      await Bun.write(args[args.indexOf("-o") + 1], JSON.stringify({
        version: 1, outcome: "success", status: "done", summary: "ok", reason: null, metrics: {}, artifacts: []
      }));
      console.log(JSON.stringify({ type: "thread.started", thread_id: "t-1" }));
    `);
    await chmod(executable, 0o755);

    expect(codexHarness.id).toBe("codex");
    expect(codexHarness.capabilities).toEqual({ sessionResume: true });
    const input = {
      command: executable, workspace: path.join(directory, "workspace"), artifactsDirectory: path.join(directory, "a"),
      prompt: "go", sandbox: "read-only" as const, automaticApprovals: false,
      mcp: { command: "bun", args: [] }, env: { CAPTURE: capture },
    };

    await codexHarness.run(input);
    const fresh = JSON.parse(await readFile(capture, "utf8")) as string[];
    expect(fresh[1]).not.toBe("resume");
    expect(fresh).not.toContain("--ephemeral");

    const result = await codexHarness.run({
      ...input, resumeSessionId: "sess-1", answeredQuestion: { question: "Which?", answer: "A" },
    });
    expect(result.sessionId).toBe("t-1");
    const resumed = JSON.parse(await readFile(capture, "utf8")) as string[];
    expect(resumed.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(resumed).toContain("sess-1");
  });
});
