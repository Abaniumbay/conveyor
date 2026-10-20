import { readFile } from "node:fs/promises";
import path from "node:path";

const ADVICE = "Test what this code does, or remove it if nothing needs it.";
const THRESHOLD = 80;
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);

export interface ChangedLineCoverageOptions {
  cwd: string;
  base: string;
  lcov: string;
  baselineLcov?: string;
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
  changedLinePassed: boolean;
  uncovered: UncoveredChangedLine[];
  currentUncovered: UncoveredChangedLine[];
  baseline: BaselineCoverageComparison | null;
}

export interface TotalLineCoverage {
  covered: number;
  total: number;
  percentage: number;
}

export interface BaselineCoverageComparison {
  current: TotalLineCoverage;
  baseline: TotalLineCoverage;
  drop: number;
  passed: boolean;
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

function totalLineCoverage(coverage: Map<string, Map<number, number>>, name: string): TotalLineCoverage {
  let covered = 0;
  let total = 0;
  for (const [file, lines] of coverage) {
    if (!isProductionFile(file)) continue;
    for (const hits of lines.values()) {
      total += 1;
      if (hits > 0) covered += 1;
    }
  }
  if (total === 0) throw new Error(`${name} contains no line coverage`);
  return { covered, total, percentage: (covered / total) * 100 };
}

function isWithinBaselineTolerance(current: TotalLineCoverage, baseline: TotalLineCoverage): boolean {
  const currentCovered = BigInt(current.covered);
  const currentTotal = BigInt(current.total);
  const baselineCovered = BigInt(baseline.covered);
  const baselineTotal = BigInt(baseline.total);
  return (baselineCovered * currentTotal - currentCovered * baselineTotal) * 1_000n <= baselineTotal * currentTotal;
}

function isProductionFile(file: string): boolean {
  const normalized = file.replaceAll("\\", "/");
  if (!SOURCE_EXTENSIONS.has(path.extname(normalized))) return false;
  if (normalized.startsWith("test/") || normalized.startsWith("tests/") || normalized.includes("/__tests__/")) return false;
  if (/\.(?:test|spec)\.[^.]+$/.test(normalized)) return false;
  if (normalized === "src/db/migrations.ts" || /(?:^|\/)migrations?(?:\/|$)/.test(normalized)) return false;
  if (/(?:^|\/)generated(?:\/|$)/.test(normalized) || /(?:^|\/)generated\.[^.]+$/.test(normalized) || /\.generated\.[^.]+$/.test(normalized)) return false;
  return true;
}

function isExecutableSourceLine(source: string): boolean {
  const trimmed = source.trim();
  return trimmed.length > 0 && !trimmed.startsWith("//") && !trimmed.startsWith("/*") && !trimmed.startsWith("*") && !["{", "}", "};", ");", "];"].includes(trimmed);
}

async function uncoveredProductionLines(cwd: string, coverage: Map<string, Map<number, number>>): Promise<UncoveredChangedLine[]> {
  const uncovered: UncoveredChangedLine[] = [];
  for (const [file, lines] of coverage) {
    if (!isProductionFile(file)) continue;
    const target = path.resolve(cwd, file);
    const relative = path.relative(cwd, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    const source = (await readFile(target, "utf8")).split("\n");
    for (const [line, hits] of lines) {
      if (hits === 0) uncovered.push({ file, line, source: source[line - 1] ?? "" });
    }
  }
  return uncovered.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
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

  const changedLinePassed = total === 0 || (covered / total) * 100 >= THRESHOLD;
  let baseline: BaselineCoverageComparison | null = null;
  let currentUncovered: UncoveredChangedLine[] = [];
  if (options.baselineLcov !== undefined) {
    const baselineCoverage = parseLcov(options.cwd, await readFile(path.resolve(options.cwd, options.baselineLcov), "utf8"));
    const current = totalLineCoverage(coverage, "Current LCOV report");
    const main = totalLineCoverage(baselineCoverage, "Main LCOV report");
    const drop = main.percentage - current.percentage;
    baseline = { current, baseline: main, drop, passed: isWithinBaselineTolerance(current, main) };
    if (!baseline.passed) currentUncovered = await uncoveredProductionLines(options.cwd, coverage);
  }

  return { covered, total, changedLinePassed, passed: changedLinePassed && (baseline?.passed ?? true), uncovered, currentUncovered, baseline };
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
  const details = ranges([...new Map(
    [...result.uncovered, ...(result.baseline && !result.baseline.passed ? result.currentUncovered : [])]
      .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
      .map((line) => [`${line.file}:${line.line}`, line]),
  ).values()]).flatMap((range) => {
    const first = range[0]!;
    const last = range.at(-1)!;
    const location = first.line === last.line ? `${first.file}:${first.line}` : `${first.file}:${first.line}-${last.line}`;
    return [location, ...range.map((line) => `  ${line.line} | ${line.source}`)];
  });
  const percentage = result.total === 0 ? 100 : (result.covered / result.total) * 100;
  const baseline = result.baseline && !result.baseline.passed
    ? [`Total line coverage: ${result.baseline.current.percentage.toFixed(1)}% (main baseline: ${result.baseline.baseline.percentage.toFixed(1)}%; drop: ${result.baseline.drop.toFixed(1)} percentage points; maximum: 0.1)`]
    : [];
  return [...details, `Changed-line coverage: ${result.covered}/${result.total} (${percentage.toFixed(1)}%)`, ...baseline, ADVICE].join("\n");
}

/** Parses the command-line options accepted by the changed-line coverage check. */
export function parseChangedCoverageArguments(args: string[]): { base: string; lcov: string; baselineLcov: string | undefined } {
  let base = "origin/main";
  let lcov = "coverage/lcov.info";
  let baselineLcov: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--base" && value) {
      base = value;
      index += 1;
    } else if (argument === "--lcov" && value) {
      lcov = value;
      index += 1;
    } else if (argument === "--baseline-lcov" && value) {
      baselineLcov = value;
      index += 1;
    } else {
      throw new Error("usage: check-changed-coverage.ts [--base <git-ref>] [--lcov <file>] [--baseline-lcov <file>]");
    }
  }
  return { base, lcov, baselineLcov };
}

async function main(): Promise<void> {
  const { baselineLcov, ...options } = parseChangedCoverageArguments(Bun.argv.slice(2));
  const result = await checkChangedCoverage({ cwd: process.cwd(), ...options, ...(baselineLcov === undefined ? {} : { baselineLcov }) });
  if (result.passed) {
    const percentage = result.total === 0 ? 100 : (result.covered / result.total) * 100;
    console.log(`Changed-line coverage: ${result.covered}/${result.total} (${percentage.toFixed(1)}%)`);
    return;
  }
  console.error(formatChangedCoverageFailure(result));
  process.exitCode = 1;
}

if (import.meta.main) await main();
