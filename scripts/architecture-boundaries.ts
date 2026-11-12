#!/usr/bin/env bun
// Architecture boundaries (#667): provider, harness and storage implementations stay behind ports.
// Scans every module under src/ and reports each import or call that crosses a boundary. Known
// violations are listed in scripts/architecture-allowlist.json, which may only shrink.
//
//   bun run scripts/architecture-boundaries.ts            prints the current violations as JSON

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface Violation {
  rule: BoundaryRule;
  /** Repository-relative path of the module that crosses the boundary. */
  file: string;
  /** What it reaches: a repository-relative module path, `bun:sqlite` or `.sqlite()`. */
  target: string;
}

export type BoundaryRule = "implementation-import" | "plugin-import" | "sqlite-access";

export const RULES: Record<BoundaryRule, string> = {
  "implementation-import": "Only the composition root and the implementation itself may import a provider or harness implementation; everything else goes through a port (src/codehost/types.ts, src/app/ci-provider.ts, src/harness/types.ts, src/source/types.ts, src/core/plugins.ts).",
  "plugin-import": "A plugin may not import another plugin; shared provider code lives in that provider's own folder.",
  "sqlite-access": "Only src/db may use SQLite directly; everything else goes through a store method.",
};

/** Provider and harness implementations (every plugin is one): reached only through ports. */
const IMPLEMENTATIONS = [
  /^src\/plugins\/[^/]+\//,
  /^src\/runner\/(codex|codex-check|codex-steering|claude-code)\.ts$/,
];

/** The composition root builds implementations and hands their ports to the core. */
const COMPOSITION_ROOTS = new Set(["src/cli/commands/serve.ts", "src/cli/plugins.ts", "src/plugins/index.ts"]);

const SOURCE = /\.(ts|tsx)$/;

function isImplementation(file: string): boolean {
  return IMPLEMENTATIONS.some((pattern) => pattern.test(file));
}

/** The plugin a module belongs to (`src/plugins/<name>/…`), or null. */
function pluginOf(file: string): string | null {
  return /^src\/plugins\/([^/]+)\//.exec(file)?.[1] ?? null;
}

/** Every module specifier a source file imports or re-exports, including type-only and dynamic imports. */
export function importSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const specifiers: string[] = [];
  for (const pattern of [/\b(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g]) {
    for (const match of code.matchAll(pattern)) specifiers.push(match[1]!);
  }
  return specifiers;
}

/** Resolves a relative specifier to a repository-relative module path; bare specifiers stay as written. */
function resolve(file: string, specifier: string, files: ReadonlySet<string>): string {
  if (!specifier.startsWith(".")) return specifier;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).replace(/\.js$/, "");
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (files.has(candidate)) return candidate;
  }
  return base;
}

/** The boundary violations of one module, given the set of all module paths. */
export function violationsOf(file: string, source: string, files: ReadonlySet<string>): Violation[] {
  const violations: Violation[] = [];
  const plugin = pluginOf(file);
  for (const specifier of importSpecifiers(source)) {
    const target = resolve(file, specifier, files);
    if (target === "bun:sqlite" && !file.startsWith("src/db/")) {
      violations.push({ rule: "sqlite-access", file, target });
    }
    if (isImplementation(target) && !isImplementation(file) && !COMPOSITION_ROOTS.has(file)) {
      violations.push({ rule: "implementation-import", file, target });
    }
    const targetPlugin = pluginOf(target);
    if (plugin && targetPlugin && targetPlugin !== plugin) {
      violations.push({ rule: "plugin-import", file, target });
    }
  }
  if (!file.startsWith("src/db/") && /\.sqlite\(\)/.test(source)) {
    violations.push({ rule: "sqlite-access", file, target: ".sqlite()" });
  }
  return dedupe(violations);
}

function dedupe(violations: Violation[]): Violation[] {
  const seen = new Set<string>();
  return violations.filter((violation) => {
    const key = violationKey(violation);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function violationKey(violation: Violation): string {
  return `${violation.rule} ${violation.file} -> ${violation.target}`;
}

async function listSources(root: string, directory = "src"): Promise<string[]> {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return listSources(root, relative);
    return SOURCE.test(entry.name) && !entry.name.endsWith(".d.ts") ? [relative] : [];
  }));
  return files.flat();
}

/** Every boundary violation under `<root>/src`, sorted. */
export async function findViolations(root: string): Promise<Violation[]> {
  const files = await listSources(root);
  const known = new Set(files);
  const all = await Promise.all(files.map(async (file) => violationsOf(file, await readFile(path.join(root, file), "utf8"), known)));
  return all.flat().sort((a, b) => violationKey(a).localeCompare(violationKey(b)));
}

if (import.meta.main) {
  console.log(JSON.stringify(await findViolations(path.join(import.meta.dir, "..")), null, 2));
}
