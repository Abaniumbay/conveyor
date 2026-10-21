import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const helper = path.resolve(import.meta.dir, "bwrap.ts");

function probeWithoutBwrap(ci: string | undefined) {
  const emptyPath = mkdtempSync(path.join(tmpdir(), "no-bwrap-"));
  const env: Record<string, string> = { PATH: emptyPath };
  if (ci) env.CI = ci;
  const script = `import { bwrapUnavailableReason } from ${JSON.stringify(helper)}; console.log(JSON.stringify(bwrapUnavailableReason()));`;
  return Bun.spawnSync([process.execPath, "-e", script], { env, stdout: "pipe", stderr: "pipe" });
}

test("the probe fails the process with the availability reason under CI", () => {
  const result = probeWithoutBwrap("true");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("bwrap is required in CI but unavailable: bwrap is not installed");
});

test("the probe reports the reason so dependent tests skip outside CI", () => {
  const result = probeWithoutBwrap(undefined);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toBe("bwrap is not installed");
});
