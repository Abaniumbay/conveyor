#!/usr/bin/env bun
// Builds the release: a single executable per target (Bun runtime and every application module,
// asset and packaged default embedded), packed with the license, third-party notices and install
// notes as conveyor-v<version>-linux-<arch>.tar.gz, plus checksums.txt.
//
//   bun run scripts/build.ts [--target linux-x64|linux-arm64]... [--out dist]

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
export const TARGETS = { "linux-x64": "bun-linux-x64", "linux-arm64": "bun-linux-arm64" } as const;
export type Target = keyof typeof TARGETS;

interface PackageJson {
  name: string;
  version: string;
  license?: string;
  dependencies?: Record<string, string>;
}

async function run(argv: string[], cwd = ROOT): Promise<string> {
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`${argv.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`);
  return stdout.trim();
}

/** The production dependency closure, resolved like Node: nested node_modules first, then hoisted. */
async function dependencyClosure(): Promise<Array<{ name: string; version: string; license: string; directory: string }>> {
  const seen = new Map<string, { name: string; version: string; license: string; directory: string }>();
  const visit = async (name: string, from: string) => {
    let directory = from;
    let candidate = path.join(directory, "node_modules", name);
    while (!existsSync(path.join(candidate, "package.json"))) {
      if (directory === ROOT || directory === path.dirname(directory)) return;
      directory = path.dirname(directory);
      candidate = path.join(directory, "node_modules", name);
    }
    if (seen.has(candidate)) return;
    const manifest = JSON.parse(await readFile(path.join(candidate, "package.json"), "utf8")) as PackageJson;
    seen.set(candidate, { name: manifest.name, version: manifest.version, license: manifest.license ?? "UNKNOWN", directory: candidate });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) await visit(dependency, candidate);
  };
  const root = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as PackageJson;
  for (const dependency of Object.keys(root.dependencies ?? {})) await visit(dependency, ROOT);
  return [...seen.values()].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

/** THIRD_PARTY_NOTICES.txt: the embedded runtime and every bundled package with its license text. */
export async function thirdPartyNotices(bunVersion: string): Promise<string> {
  const sections = [
    "Third-party software included in the Conveyor executable",
    "=========================================================",
    "",
    `Bun ${bunVersion} (runtime embedded in the executable) - MIT License.`,
    "Bun statically links JavaScriptCore and other components under their own licenses (including",
    "LGPL-2.1 for JavaScriptCore/WebKit). Their notices and source offers are listed at",
    "https://bun.com/docs/project/license and in Bun's repository at https://github.com/oven-sh/bun.",
    "",
  ];
  for (const dependency of await dependencyClosure()) {
    const files = (await readdir(dependency.directory)).filter((file) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file)).sort();
    sections.push("-".repeat(78), `${dependency.name} ${dependency.version} - ${dependency.license}`, "");
    for (const file of files) sections.push((await readFile(path.join(dependency.directory, file), "utf8")).trim(), "");
    if (files.length === 0) sections.push(`(no license file shipped; licensed under ${dependency.license})`, "");
  }
  return `${sections.join("\n")}\n`;
}

const INSTALL_NOTES = (version: string, target: string) => `Conveyor ${version} for ${target}
=================================

This archive holds the complete application: one executable with its runtime, dashboard, packaged
default configuration, MCP server and sandbox bridge. Nothing else is needed from Conveyor itself.

Install (the release's install.sh does this, and verifies the checksum first):

  mkdir -p ~/.local/share/conveyor/versions/${version}
  cp conveyor ~/.local/share/conveyor/versions/${version}/
  ln -sfn versions/${version} ~/.local/share/conveyor/current
  ln -sfn ~/.local/share/conveyor/current/conveyor ~/.local/bin/conveyor

Then:

  conveyor init        # creates ~/.conveyor: configuration, state, logs
  conveyor doctor      # lists missing prerequisites (git, gh, bwrap, agent CLIs) with fixes
  conveyor serve       # or: conveyor service install, then conveyor service start

Documentation: https://github.com/Abaniumbay/conveyor#readme
`;

export interface BuildResult {
  version: string;
  commit: string;
  archives: string[];
  checksums: string;
}

export async function build(options: { targets: Target[]; out: string; builtAt?: string }): Promise<BuildResult> {
  const manifest = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as PackageJson;
  const version = manifest.version;
  const commit = await run(["git", "rev-parse", "HEAD"]);
  const builtAt = options.builtAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const out = path.resolve(options.out);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const notices = await thirdPartyNotices(Bun.version);
  const archives: string[] = [];

  for (const target of options.targets) {
    const name = `conveyor-v${version}-${target}`;
    const staging = path.join(out, name);
    await mkdir(staging, { recursive: true });
    const executable = path.join(staging, "conveyor");
    await run([
      process.execPath, "build", path.join(ROOT, "src/cli.ts"),
      "--compile", "--minify", `--target=${TARGETS[target]}`, `--outfile=${executable}`,
      `--define=CONVEYOR_BUILD=${JSON.stringify({ version, commit, builtAt })}`,
    ]);
    await copyFile(path.join(ROOT, "LICENSE"), path.join(staging, "LICENSE"));
    await writeFile(path.join(staging, "THIRD_PARTY_NOTICES.txt"), notices);
    await writeFile(path.join(staging, "INSTALL.txt"), INSTALL_NOTES(version, target));
    const archive = `${name}.tar.gz`;
    await run(["tar", "-C", out, "--owner=0", "--group=0", "--numeric-owner", "-czf", path.join(out, archive), name]);
    await rm(staging, { recursive: true });
    archives.push(archive);
  }

  await copyFile(path.join(ROOT, "scripts/install.sh"), path.join(out, "install.sh"));
  const lines: string[] = [];
  for (const file of [...archives, "install.sh"]) {
    const digest = createHash("sha256").update(await readFile(path.join(out, file))).digest("hex");
    lines.push(`${digest}  ${file}`);
  }
  const checksums = `${lines.join("\n")}\n`;
  await writeFile(path.join(out, "checksums.txt"), checksums);
  return { version, commit, archives, checksums };
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const targets: Target[] = [];
  let out = path.join(ROOT, "dist");
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]];
    if (flag === "--target" && value && value in TARGETS) targets.push(value as Target);
    else if (flag === "--out" && value) out = value;
    else throw new Error(`usage: bun run scripts/build.ts [--target ${Object.keys(TARGETS).join("|")}]... [--out <dir>]`);
  }
  const result = await build({ targets: targets.length > 0 ? targets : ["linux-x64"], out });
  console.log(`Built Conveyor ${result.version} (${result.commit.slice(0, 12)}) into ${out}:`);
  for (const archive of result.archives) console.log(`  ${archive}`);
  console.log("  install.sh\n  checksums.txt");
}
