import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkChangedCoverage, formatChangedCoverageFailure, parseChangedCoverageArguments } from "../../scripts/check-changed-coverage";

const directories: string[] = [];
const SCRIPT = path.resolve(import.meta.dir, "../../scripts/check-changed-coverage.ts");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  const process = Bun.spawn(["git", "-c", "user.name=Tests", "-c", "user.email=tests@example.com", ...args], {
    cwd, stdout: "pipe", stderr: "pipe",
  });
  if (await process.exited !== 0) throw new Error(await new Response(process.stderr).text());
}

async function fixture(files: Record<string, string>, lcov: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-changed-coverage-"));
  directories.push(root);
  await git(root, "init", "--initial-branch=main", "--quiet");
  await writeFiles(root, files);
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "--allow-empty", "--message", "base");
  await git(root, "checkout", "--quiet", "-b", "feature");
  if (Object.keys(files).length > 0) {
    await writeFiles(root, {
      "src/covered.ts": "export const covered = 1;\nexport const untested = 2;\n",
      "tests/covered.test.ts": "test(\"ignored\", () => {});\n",
      "src/generated.ts": "export const generated = true;\n",
      "src/db/migrations.ts": "export const migration = 1;\n",
    });
    await commitChanges(root);
  }
  await writeFile(path.join(root, "lcov.info"), lcov);
  return root;
}

async function commitChanges(root: string): Promise<void> {
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "--message", "change");
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  await Promise.all(Object.entries(files).map(async ([file, contents]) => {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }));
}

test("excludes test files, generated code, and database migrations from changed-line coverage", async () => {
  const root = await fixture({
    "src/covered.ts": "export const covered = 0;\n",
    "tests/covered.test.ts": "",
    "src/generated.ts": "",
    "src/db/migrations.ts": "",
  }, "SF:src/covered.ts\nDA:1,1\nDA:2,1\nend_of_record\n");

  await expect(checkChangedCoverage({ cwd: root, base: "main", lcov: "lcov.info" })).resolves.toMatchObject({
    passed: true, covered: 2, total: 2, uncovered: [],
  });
});

test("counts executable added lines in a new production file without LCOV as uncovered", async () => {
  const root = await fixture({}, "");
  await writeFiles(root, { "src/new.ts": "export const newCode = () => 1;\n" });
  await commitChanges(root);

  await expect(checkChangedCoverage({ cwd: root, base: "main", lcov: "lcov.info" })).resolves.toMatchObject({
    passed: false, covered: 0, total: 1,
    uncovered: [{ file: "src/new.ts", line: 1, source: "export const newCode = () => 1;" }],
  });
});

test("fails below 80 percent and passes at the 80 percent threshold", async () => {
  const below = await fixture({ "src/covered.ts": "export const covered = 0;\n" }, "SF:src/covered.ts\nDA:1,1\nDA:2,0\nend_of_record\n");
  await expect(checkChangedCoverage({ cwd: below, base: "main", lcov: "lcov.info" })).resolves.toMatchObject({
    passed: false, covered: 1, total: 2,
  });

  const threshold = await fixture({ "src/covered.ts": "export const covered = 0;\n" }, "SF:src/covered.ts\nDA:1,1\nDA:2,1\nDA:3,1\nDA:4,1\nDA:5,0\nend_of_record\n");
  await writeFiles(threshold, {
    "src/covered.ts": "export const one = 1;\nexport const two = 2;\nexport const three = 3;\nexport const four = 4;\nexport const five = 5;\n",
  });
  await commitChanges(threshold);
  await expect(checkChangedCoverage({ cwd: threshold, base: "main", lcov: "lcov.info" })).resolves.toMatchObject({
    passed: true, covered: 4, total: 5,
  });
});

test("formats adjacent uncovered lines as a source-first range", async () => {
  const root = await fixture({}, "");
  await writeFiles(root, { "src/new.ts": "export const first = 1;\nexport const second = 2;\n" });
  await commitChanges(root);

  const result = await checkChangedCoverage({ cwd: root, base: "main", lcov: "lcov.info" });
  expect(formatChangedCoverageFailure(result)).toBe([
    "src/new.ts:1-2",
    "  1 | export const first = 1;",
    "  2 | export const second = 2;",
    "Changed-line coverage: 0/2 (0.0%)",
    "Test what this code does, or remove it if nothing needs it.",
  ].join("\n"));
});

test("accepts coverage command options and rejects malformed arguments", () => {
  expect(parseChangedCoverageArguments(["--base", "main", "--lcov", "result.lcov"])).toEqual({ base: "main", lcov: "result.lcov" });
  expect(parseChangedCoverageArguments([])).toEqual({ base: "origin/main", lcov: "coverage/lcov.info" });
  expect(() => parseChangedCoverageArguments(["--base"])).toThrow("usage: check-changed-coverage.ts [--base <git-ref>] [--lcov <file>]");
});

test("prints every uncovered changed range and source before the percentage and requested advice", async () => {
  const root = await fixture({}, "");
  await writeFiles(root, {
    "src/first.ts": "export const first = 1;\nexport const second = 2;\n",
    "src/second.ts": "export const third = 3;\n",
  });
  await commitChanges(root);

  const process = Bun.spawn(["bun", SCRIPT, "--base", "main", "--lcov", "lcov.info"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(await process.exited).toBe(1);
  const output = await new Response(process.stderr).text();
  expect(output).toStartWith("src/first.ts:1-2\n  1 | export const first = 1;\n  2 | export const second = 2;\nsrc/second.ts:1\n  1 | export const third = 3;");
  expect(output.indexOf("src/second.ts:1")).toBeLessThan(output.indexOf("Changed-line coverage:"));
  expect(output.trimEnd()).toEndWith("Test what this code does, or remove it if nothing needs it.");
});

test("the existing Check job writes LCOV before it runs the changed-line gate", async () => {
  const workflow = await readFile(path.resolve(import.meta.dir, "../../.github/workflows/check.yml"), "utf8");
  expect(workflow).toContain("bun test --coverage --coverage-reporter=lcov");
  expect(workflow).toContain("bun run scripts/check-changed-coverage.ts --base origin/main --lcov coverage/lcov.info");
  expect(workflow.indexOf("bun test --coverage --coverage-reporter=lcov")).toBeLessThan(workflow.indexOf("bun run scripts/check-changed-coverage.ts"));
});
