// `conveyor config migrate`: writes a tag-based conveyor.yaml that reproduces the effective
// configuration of a deprecated configuration directory (or a pinned import), then proves it by
// loading both and comparing their compiled plans and effective configuration.

import { chmod, copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Scalar, stringify } from "yaml";

import type { TaskRegistry } from "../tasks/contract";
import { ConfigError } from "./errors";
import { placeholderKey } from "./compose";
import { loadConfig, readConfiguration, type ConveyorConfig } from "./load";

type Document = Record<string, unknown>;

export interface MigrationResult {
  entrypoint: string;
  /** Files written, relative to the target directory. */
  written: string[];
  /** Instruction files copied into the target: [source, destination relative to the target]. */
  copied: Array<[string, string]>;
  plansIdentical: boolean;
  /** Top-level sections whose effective value differs (empty when the migration is exact). */
  differences: string[];
  /** Notes for the operator. */
  notes: string[];
}

function isObject(value: unknown): value is Document {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renameKeys(entries: unknown, renames: Record<string, string>): void {
  if (!isObject(entries)) return;
  for (const entry of Object.values(entries)) {
    if (!isObject(entry)) continue;
    for (const [from, to] of Object.entries(renames)) {
      if (!(from in entry)) continue;
      entry[to] = entry[from];
      delete entry[from];
    }
  }
}

/** The merged document with the internal section names turned back into the canonical ones. */
function canonical(merged: Document): Document {
  const document = structuredClone(merged);
  const providers: Document = {};
  for (const [section, role] of [["sources", "items"], ["codeHosts", "code"], ["ci", "ci"]] as const) {
    if (!(section in document)) continue;
    if (isObject(document[section]) && Object.keys(document[section] as Document).length > 0) providers[role] = document[section];
    delete document[section];
  }
  if (Object.keys(providers).length > 0) document.providers = providers;
  if ("runners" in document) {
    document.harnesses = document.runners;
    delete document.runners;
  }
  renameKeys(document.agents, { runner: "harness", workspaceAccess: "access" });
  renameKeys(document.repositories, { source: "items", codeHost: "code" });
  return document;
}

/** The parts of a loaded configuration that must survive the migration, instructions compared by content. */
async function comparable(config: ConveyorConfig): Promise<Document> {
  const { hash: _hash, root: _root, plans: _plans, mode: _mode, warnings: _warnings, secrets: _secrets, import: _import, ...data } = config;
  const agents: Document = {};
  for (const [name, agent] of Object.entries(data.agents)) {
    agents[name] = { ...agent, instructions: await readFile(agent.instructions, "utf8").catch(() => `missing: ${agent.instructions}`) };
  }
  return { ...data, agents };
}

const SECTION_FILES = ["providers", "harnesses", "agents", "checks", "pipelines"] as const;

/**
 * Turns each placeholder left where a `!secret` was back into `!secret <key>`, so no credential is
 * written into the files meant to be committed. Returns the keys it used.
 */
function restoreSecretReferences(document: Document): Set<string> {
  const used = new Set<string>();
  const visit = (value: unknown): unknown => {
    const key = placeholderKey(value);
    if (key !== null) {
      used.add(key);
      const reference = new Scalar(key);
      reference.tag = "!secret";
      return reference;
    }
    if (typeof value === "string" && value.includes("\u0000conveyor-secret:")) {
      throw new ConfigError("a !secret value was rewritten (it is used as a path); move that value out of secrets.yaml before migrating");
    }
    if (Array.isArray(value)) return value.map(visit);
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry)]));
    return value;
  };
  for (const [section, value] of Object.entries(document)) document[section] = visit(value);
  return used;
}

export async function migrateConfiguration(
  from: string,
  to: string,
  options: { home?: string; registry?: TaskRegistry | null } = {},
): Promise<MigrationResult> {
  const target = path.resolve(to);
  const existing = await stat(target).catch(() => undefined);
  if (existing && (!existing.isDirectory() || (await readdir(target)).length > 0)) {
    throw new ConfigError(`${target} must not exist or must be an empty directory`);
  }
  const loadOptions = options.home ? { home: options.home } : {};
  const old = await loadConfig(from, options.registry, loadOptions);
  // Placeholders mark exactly where each !secret was, so the references are restored by place.
  const source = await readConfiguration(from, { ...loadOptions, secretPlaceholders: true });
  const document = canonical(source.merged);
  const notes: string[] = [];

  // Instruction files move into the configuration; everything else (scripts, folders, state
  // paths) keeps its absolute path, so the compiled plans stay identical.
  const copied: Array<[string, string]> = [];
  const destinations = new Map<string, string>();
  for (const [name, agent] of Object.entries(isObject(document.agents) ? document.agents : {})) {
    if (!isObject(agent) || typeof agent.instructions !== "string") continue;
    const sourceFile = agent.instructions;
    if (!(await stat(sourceFile).catch(() => undefined))?.isFile()) continue;
    let destination = destinations.get(sourceFile);
    if (!destination) {
      const base = path.basename(sourceFile);
      destination = [...destinations.values()].includes(`instructions/${base}`) ? `instructions/${name}-${base}` : `instructions/${base}`;
      destinations.set(sourceFile, destination);
      await mkdir(path.join(target, "instructions"), { recursive: true });
      await copyFile(sourceFile, path.join(target, destination));
      copied.push([sourceFile, destination]);
    }
    agent.instructions = `./${destination}`;
  }

  await mkdir(target, { recursive: true });
  const usedSecrets = restoreSecretReferences(document);
  const written: string[] = [];
  const write = async (relative: string, content: string) => {
    await mkdir(path.dirname(path.join(target, relative)), { recursive: true });
    await writeFile(path.join(target, relative), content);
    written.push(relative);
  };
  const yaml = (value: unknown) => stringify(value, { aliasDuplicateObjects: false, lineWidth: 0 });

  const includes: string[] = [];
  for (const section of SECTION_FILES) {
    const value = document[section];
    delete document[section];
    if (!isObject(value) || Object.keys(value).length === 0) continue;
    await write(`${section}.yaml`, yaml(value));
    includes.push(`${section}: !include ${section}.yaml`);
  }
  const repositories = isObject(document.repositories) ? document.repositories : {};
  delete document.repositories;
  for (const [name, repository] of Object.entries(repositories)) {
    if (!/^[\w.-]+$/.test(name) || name.startsWith(".")) {
      throw new ConfigError(`repository "${name}" cannot be a file name; rename it before migrating`);
    }
    await write(`repositories/${name}.yaml`, yaml(repository));
  }
  if (Object.keys(repositories).length > 0) includes.push("repositories: !include_dir_named repositories/");

  const header = [
    `# Conveyor configuration, migrated from ${path.resolve(from)} by \`conveyor config migrate\`.`,
    "# Each section below is either inline or included from the file the tag names.",
    "",
  ].join("\n");
  await write("conveyor.yaml", `${header}${yaml(document)}\n${includes.join("\n")}\n`);
  await write(".gitignore", "secrets.yaml\n");
  if (usedSecrets.size > 0) {
    const values = Object.fromEntries([...usedSecrets].sort().map((key) => [key, source.secretKeys[key]]));
    await write("secrets.yaml", `# Secrets referenced with !secret <key>. Never commit this file.\n${yaml(values)}`);
    await chmod(path.join(target, "secrets.yaml"), 0o600);
    notes.push(`${usedSecrets.size} secret value(s) stay in secrets.yaml (git-ignored) and are referenced with !secret.`);
  }
  if (source.resolvedImport) {
    notes.push(`The pinned import (${source.resolvedImport.ref} = ${source.resolvedImport.sha.slice(0, 12)}) is now inlined; switch a section to \`!include builtin:<file>\` to follow the packaged defaults instead.`);
  }
  const scripts = old.plans.some((plan) => plan.stages.some((stage) => [...stage.actions, ...stage.exitGate].some((task) => task.task === "script.run")));
  if (scripts) notes.push("Script paths are unchanged (absolute). Move the scripts into the configuration repository by hand if you want them versioned with it.");

  const entrypoint = path.join(target, "conveyor.yaml");
  const migrated = await loadConfig(entrypoint, options.registry, loadOptions);
  const [left, right] = [await comparable(old), await comparable(migrated)];
  const differences = [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => !Bun.deepEquals(left[key], right[key], true))
    .sort();
  return {
    entrypoint,
    written,
    copied,
    plansIdentical: Bun.deepEquals(old.plans, migrated.plans, true),
    differences,
    notes,
  };
}
