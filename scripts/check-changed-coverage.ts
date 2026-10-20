import { readFile } from "node:fs/promises";
import path from "node:path";

const ADVICE = "Test what this code does, or remove it if nothing needs it.";
const THRESHOLD = 80;
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);

export interface ChangedLineCoverageOptions {
  cwd: string;
  base: string;
  lcov: string;
}

export interface UncoveredChangedLine {
  file: string;
  line: number;
  source: string;
}

export interface ChangedLineCoverageResult {
  covered: number;
  total: number;
  passed: boolean;
  uncovered: UncoveredChangedLine[];
}

interface ChangedLine {
  file: string;
  line: number;
  source: string;
}

function runGit(cwd: string, args: string[]): string {
  const process = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (process.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${process.stderr.toString().trim()}`);
  return process.stdout.toString();
}

function changedLines(cwd: string, base: string): ChangedLine[] {
  const diff = runGit(cwd, ["diff", "--no-ext-diff", "--unified=0", "--find-renames", "--diff-filter=ACMRT", `${base}...HEAD`, "--"]);
  const lines: ChangedLine[] = [];
  let file: string | undefined;
  let nextLine: number | undefined;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice(6);
      nextLine = undefined;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      nextLine = Number(hunk[1]);
      continue;
    }
    if (file !== undefined && nextLine !== undefined && line.startsWith("+") && !line.startsWith("+++")) {
      lines.push({ file, line: nextLine, source: line.slice(1) });
      nextLine += 1;
    }
  }
  return lines;
}

function normalizeSourceFile(cwd: string, sourceFile: string): string {
  return path.relative(cwd, path.resolve(cwd, sourceFile)).split(path.sep).join("/");
}

function parseLcov(cwd: string, lcov: string): Map<string, Map<number, number>> {
  const coverage = new Map<string, Map<number, number>>();
  let current: Map<number, number> | undefined;
  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) {
      const file = normalizeSourceFile(cwd, line.slice(3));
      current = coverage.get(file) ?? new Map<number, number>();
      coverage.set(file, current);
      continue;
    }
    const match = /^DA:(\d+),(\d+)$/.exec(line);
    if (match && current) current.set(Number(match[1]), Number(match[2]));
  }
  return coverage;
}

function isProductionFile(file: string): boolean {
  const normalized = file.replaceAll("\\", "/");
  if (!SOURCE_EXTENSIONS.has(path.extname(normalized))) return false;
  if (normalized.startsWith("test/") || normalized.startsWith("tests/") || normalized.includes("/__tests__/")) return false;
  if (/\.(?:test|spec)\.[^.]+$/.test(normalized)) return false;
  if (normalized === "src/db/migrations.ts" || /(?:^|\/)migrations?(?:\/|$)/.test(normalized)) return false;
  // The dashboard application runs only in a browser, where the Playwright suites exercise it; the
  // scripts (packaging, smoke test, benchmark) run as their own CI steps. Neither reaches `bun test --coverage`.
  if (normalized.startsWith("src/web/app/") || normalized.startsWith("scripts/")) return false;
  if (/(?:^|\/)generated(?:\/|$)/.test(normalized) || /(?:^|\/)generated\.[^.]+$/.test(normalized) || /\.generated\.[^.]+$/.test(normalized)) return false;
  return true;
}

function isExecutableSourceLine(source: string): boolean {
  const trimmed = source.trim();
  return trimmed.length > 0 && !trimmed.startsWith("//") && !trimmed.startsWith("/*") && !trimmed.startsWith("*") && !["{", "}", "};", ");", "];"].includes(trimmed);
}

/** Compares added production lines in a Git diff against the LCOV evidence from the test run. */
export async function checkChangedCoverage(options: ChangedLineCoverageOptions): Promise<ChangedLineCoverageResult> {
  const coverage = parseLcov(options.cwd, await readFile(path.resolve(options.cwd, options.lcov), "utf8"));
  const uncovered: UncoveredChangedLine[] = [];
  let covered = 0;
  let total = 0;

  for (const changed of changedLines(options.cwd, options.base)) {
    if (!isProductionFile(changed.file)) continue;
    const fileCoverage = coverage.get(changed.file);
    if (fileCoverage) {
      const hits = fileCoverage.get(changed.line);
      if (hits === undefined) continue;
      total += 1;
      if (hits > 0) covered += 1;
      else uncovered.push(changed);
      continue;
    }
    if (!isExecutableSourceLine(changed.source)) continue;
    total += 1;
    uncovered.push(changed);
  }

  return { covered, total, passed: total === 0 || (covered / total) * 100 >= THRESHOLD, uncovered };
}

function ranges(lines: UncoveredChangedLine[]): UncoveredChangedLine[][] {
  const output: UncoveredChangedLine[][] = [];
  for (const line of lines) {
    const previous = output.at(-1);
    if (previous && previous[0]?.file === line.file && previous.at(-1)?.line === line.line - 1) previous.push(line);
    else output.push([line]);
  }
  return output;
}

export function formatChangedCoverageFailure(result: ChangedLineCoverageResult): string {
  const details = ranges(result.uncovered).flatMap((range) => {
    const first = range[0]!;
    const last = range.at(-1)!;
    const location = first.line === last.line ? `${first.file}:${first.line}` : `${first.file}:${first.line}-${last.line}`;
    return [location, ...range.map((line) => `  ${line.line} | ${line.source}`)];
  });
  const percentage = result.total === 0 ? 100 : (result.covered / result.total) * 100;
  return [...details, `Changed-line coverage: ${result.covered}/${result.total} (${percentage.toFixed(1)}%)`, ADVICE].join("\n");
}

/** Parses the command-line options accepted by the changed-line coverage check. */
export function parseChangedCoverageArguments(args: string[]): Pick<ChangedLineCoverageOptions, "base" | "lcov"> {
  let base = "origin/main";
  let lcov = "coverage/lcov.info";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--base" && value) {
      base = value;
      index += 1;
    } else if (argument === "--lcov" && value) {
      lcov = value;
      index += 1;
    } else {
      throw new Error("usage: check-changed-coverage.ts [--base <git-ref>] [--lcov <file>]");
    }
  }
  return { base, lcov };
}

async function main(): Promise<void> {
  const options = parseChangedCoverageArguments(Bun.argv.slice(2));
  const result = await checkChangedCoverage({ cwd: process.cwd(), ...options });
  if (result.passed) {
    const percentage = result.total === 0 ? 100 : (result.covered / result.total) * 100;
    console.log(`Changed-line coverage: ${result.covered}/${result.total} (${percentage.toFixed(1)}%)`);
    return;
  }
  console.error(formatChangedCoverageFailure(result));
  process.exitCode = 1;
}

if (import.meta.main) await main();
