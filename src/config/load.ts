import { CryptoHasher } from "bun";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import type { ZodIssue } from "zod";

import { createTaskRegistry } from "../tasks/catalogue";
import type { TaskRegistry } from "../tasks/contract";
import { compileRepositories, PlanError } from "../tasks/plan";

import { configSchema, isNativeStage, type ConveyorConfigData } from "./schema";

const NAMED_SECTIONS = [
  "sources",
  "codeHosts",
  "runners",
  "agents",
  "checks",
  "ci",
  "pipelines",
  "repositories",
] as const;
const SINGLETON_SECTIONS = ["settings", "web", "labels"] as const;

type ConfigurationDocument = Record<string, unknown>;

export interface ConveyorConfig extends ConveyorConfigData {
  hash: string;
  root: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";

  constructor(message: string) {
    super(message);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvePath(value: unknown, baseDirectory: string): unknown {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) {
    return value;
  }
  return path.resolve(baseDirectory, value);
}

function resolveScriptWith(holder: unknown, baseDirectory: string): void {
  if (isObject(holder) && isObject(holder.with) && "script" in holder.with) {
    holder.with.script = resolvePath(holder.with.script, baseDirectory);
  }
}

function resolveScriptEntry(entry: unknown, baseDirectory: string): void {
  if (isObject(entry) && entry.task === "script.run") resolveScriptWith(entry, baseDirectory);
}

function normalizeDocumentPaths(
  input: ConfigurationDocument,
  filename: string,
): ConfigurationDocument {
  const document = structuredClone(input);
  const baseDirectory = path.dirname(filename);

  if (isObject(document.settings)) {
    for (const key of ["database", "logs", "workspaces", "artifacts"] as const) {
      if (key in document.settings) {
        document.settings[key] = resolvePath(document.settings[key], baseDirectory);
      }
    }
  }

  if (isObject(document.web) && isObject(document.web.steering)) {
    if ("workspace" in document.web.steering) {
      document.web.steering.workspace = resolvePath(
        document.web.steering.workspace,
        baseDirectory,
      );
    }
  }

  if (isObject(document.agents)) {
    for (const agent of Object.values(document.agents)) {
      if (isObject(agent) && "instructions" in agent) {
        agent.instructions = resolvePath(agent.instructions, baseDirectory);
      }
    }
  }

  if (isObject(document.checks)) {
    for (const check of Object.values(document.checks)) {
      if (isObject(check) && "script" in check) {
        check.script = resolvePath(check.script, baseDirectory);
      }
    }
  }

  if (isObject(document.pipelines)) {
    for (const pipeline of Object.values(document.pipelines)) {
      if (!isObject(pipeline) || !Array.isArray(pipeline.stages)) continue;
      for (const stage of pipeline.stages) {
        if (!isObject(stage)) continue;
        if (isObject(stage.run) && "script" in stage.run) {
          stage.run.script = resolvePath(stage.run.script, baseDirectory);
        }
        for (const list of [stage.actions, stage["exit-gate"]]) {
          if (Array.isArray(list)) for (const entry of list) resolveScriptEntry(entry, baseDirectory);
        }
      }
    }
  }

  if (isObject(document.repositories)) {
    for (const repository of Object.values(document.repositories)) {
      if (isObject(repository) && "folder" in repository) {
        repository.folder = resolvePath(repository.folder, baseDirectory);
      }
      if (isObject(repository) && isObject(repository.overrides) && isObject(repository.overrides.stages)) {
        for (const stage of Object.values(repository.overrides.stages)) {
          if (!isObject(stage)) continue;
          for (const group of [stage.actions, stage["exit-gate"]]) {
            if (isObject(group)) for (const override of Object.values(group)) resolveScriptWith(override, baseDirectory);
          }
        }
      }
    }
  }

  return document;
}

async function configurationFiles(target: string): Promise<string[]> {
  const targetStat = await stat(target).catch(() => undefined);
  if (!targetStat) throw new ConfigError(`configuration path does not exist: ${target}`);
  if (targetStat.isFile()) return [target];
  if (!targetStat.isDirectory()) {
    throw new ConfigError(`configuration path is not a file or directory: ${target}`);
  }

  const entries = await readdir(target, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

function mergeDocument(
  merged: ConfigurationDocument,
  document: ConfigurationDocument,
  origins: Map<string, string>,
  filename: string,
): void {
  for (const [key, value] of Object.entries(document)) {
    if ((NAMED_SECTIONS as readonly string[]).includes(key)) {
      if (!isObject(value)) {
        merged[key] = value;
        continue;
      }
      const target = (merged[key] ??= {}) as Record<string, unknown>;
      if (!isObject(target)) continue;
      for (const [name, definition] of Object.entries(value)) {
        const originKey = `${key}.${name}`;
        const prior = origins.get(originKey);
        if (prior) {
          throw new ConfigError(
            `duplicate ${key} definition "${name}" in ${filename}; first defined in ${prior}`,
          );
        }
        origins.set(originKey, filename);
        target[name] = definition;
      }
      continue;
    }

    if ((SINGLETON_SECTIONS as readonly string[]).includes(key)) {
      const prior = origins.get(key);
      if (prior) {
        throw new ConfigError(
          `duplicate ${key} section in ${filename}; first defined in ${prior}`,
        );
      }
      origins.set(key, filename);
    }
    merged[key] = value;
  }
}

function issuePath(issue: ZodIssue): string {
  return issue.path.map(String).join(".") || "configuration";
}

function formatIssues(issues: readonly ZodIssue[]): string {
  return [
    "configuration is invalid:",
    ...issues.map((issue) => `- ${issuePath(issue)}: ${issue.message}`),
  ].join("\n");
}

function crossReferenceErrors(config: ConveyorConfigData): string[] {
  const errors: string[] = [];
  if (config.web.steering && !config.agents[config.web.steering.agent]) {
    errors.push(
      `web.steering.agent references unknown agent "${config.web.steering.agent}"`,
    );
  }
  for (const [name, agent] of Object.entries(config.agents)) {
    if (!config.runners[agent.runner]) {
      errors.push(`agents.${name}.runner references unknown runner "${agent.runner}"`);
    }
  }
  for (const [name, check] of Object.entries(config.checks)) {
    if (!config.agents[check.verifier]) {
      errors.push(`checks.${name}.verifier references unknown agent "${check.verifier}"`);
    }
  }
  for (const [pipelineName, pipeline] of Object.entries(config.pipelines)) {
    for (const [index, stage] of pipeline.stages.entries()) {
      const prefix = `pipelines.${pipelineName}.stages.${index}`;
      if (isNativeStage(stage)) {
        if (stage.childrenStartAt && stage.childrenStartAt !== "next") {
          if (!pipeline.stages.some((candidate) => candidate.id === stage.childrenStartAt)) {
            errors.push(`${prefix}.childrenStartAt references unknown stage "${stage.childrenStartAt}"`);
          }
        }
        continue;
      }
      if (stage.enterCheck && !config.checks[stage.enterCheck]) {
        errors.push(`${prefix}.enterCheck references unknown check "${stage.enterCheck}"`);
      }
      if (stage.exitCheck && !config.checks[stage.exitCheck]) {
        errors.push(`${prefix}.exitCheck references unknown check "${stage.exitCheck}"`);
      }
      if (stage.run.type === "agent" && !config.agents[stage.run.agent]) {
        errors.push(`${prefix}.run.agent references unknown agent "${stage.run.agent}"`);
      }
      if (stage.run.type === "script" && !config.runners[stage.run.runner]) {
        errors.push(`${prefix}.run.runner references unknown runner "${stage.run.runner}"`);
      }
      if (stage.run.type === "source-action" && stage.run.input?.triggers !== undefined && stage.run.action === "ci.await") {
        errors.push(`${prefix}.run.with.triggers is only supported by the deprecated pullRequest.awaitChecks action`);
      }
      if (stage.run.type === "source-action" && stage.run.input?.triggers !== undefined) {
        const triggers = stage.run.input.triggers;
        if (!Array.isArray(triggers)) errors.push(`${prefix}.run.with.triggers must be a list`);
        else triggers.forEach((trigger, triggerIndex) => {
          const triggerPath = `${prefix}.run.with.triggers.${triggerIndex}`;
          if (!isObject(trigger)) {
            errors.push(`${triggerPath} must be an object`);
            return;
          }
          if (typeof trigger.label !== "string" || !trigger.label) errors.push(`${triggerPath}.label must be a non-empty string`);
          if (typeof trigger.workflow !== "string" || !/^[\w.-]+\.ya?ml$/.test(trigger.workflow)) errors.push(`${triggerPath}.workflow must be a workflow file name`);
          if (typeof trigger.check !== "string" || !trigger.check) errors.push(`${triggerPath}.check must be a non-empty string`);
          if (trigger.replaces !== undefined && (!Array.isArray(trigger.replaces) || trigger.replaces.some((name) => typeof name !== "string" || !name))) {
            errors.push(`${triggerPath}.replaces must be a list of names`);
          }
        });
      }
      const stageIndex = pipeline.stages.indexOf(stage);
      for (const [status, policy] of Object.entries(stage.failurePolicies)) {
        if (!policy.stage) continue;
        const targetIndex = pipeline.stages.findIndex((candidate) => candidate.id === policy.stage);
        if (targetIndex < 0 || targetIndex >= stageIndex) {
          errors.push(
            `${prefix}.failurePolicies.${status}.stage must name an earlier stage, not "${policy.stage}"`,
          );
        }
      }
      if (stage.childrenStartAt && stage.childrenStartAt !== "next") {
        if (!pipeline.stages.some((candidate) => candidate.id === stage.childrenStartAt)) {
          errors.push(
            `${prefix}.childrenStartAt references unknown stage "${stage.childrenStartAt}"`,
          );
        }
      }
    }
  }
  for (const [name, repository] of Object.entries(config.repositories)) {
    if (!config.sources[repository.source]) {
      errors.push(
        `repositories.${name}.source references unknown source "${repository.source}"`,
      );
    }
    if (!config.pipelines[repository.pipeline]) {
      errors.push(
        `repositories.${name}.pipeline references unknown pipeline "${repository.pipeline}"`,
      );
    }
    const ciName = repository.ci.provider;
    if (ciName && !config.ci[ciName]) {
      errors.push(`repositories.${name}.ci references unknown CI provider "${ciName}"`);
    }
    if (ciName && config.ci[ciName]?.type !== "github-actions" && config.sources[repository.source]?.type === "github") {
      errors.push(`repositories.${name}.ci is incompatible with sources.${repository.source}`);
    }
    {
      const providerName = ciName;
      const provider = providerName ? config.ci[providerName] : undefined;
      for (const [index, stage] of config.pipelines[repository.pipeline]?.stages.entries() ?? []) {
        if (isNativeStage(stage) || stage.run.type !== "source-action" || stage.run.input?.triggers === undefined) continue;
        if (provider && provider.triggers.length > 0) errors.push(`pipelines.${repository.pipeline}.stages.${index}.run.with.triggers conflicts with ci.${providerName}.triggers`);
      }
    }
    const codeHost = repository.codeHost ?? repository.source;
    if (config.codeHosts[codeHost]) continue;
    if (codeHost === repository.source && config.sources[repository.source]?.type === "github") continue;
    errors.push(
      `repositories.${name}.codeHost references unknown or unsupported code host "${codeHost}"`,
    );
  }
  return errors;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function configurationHash(config: ConveyorConfigData): string {
  const hasher = new CryptoHasher("sha256");
  hasher.update(JSON.stringify(stableValue(config)));
  return hasher.digest("hex");
}

export async function loadConfig(
  target: string,
  /** Pass null to validate the schema only, without compiling task plans. */
  registry: TaskRegistry | null = createTaskRegistry(),
): Promise<ConveyorConfig> {
  const resolvedTarget = path.resolve(target);
  const targetStat = await stat(resolvedTarget).catch(() => undefined);
  const root = targetStat?.isDirectory()
    ? resolvedTarget
    : path.dirname(resolvedTarget);
  const files = await configurationFiles(resolvedTarget);
  if (files.length === 0) {
    throw new ConfigError(`no YAML configuration files found in ${resolvedTarget}`);
  }

  const merged: ConfigurationDocument = {};
  const origins = new Map<string, string>();
  for (const filename of files) {
    let parsed: unknown;
    try {
      parsed = parse(await readFile(filename, "utf8"));
    } catch (error) {
      throw new ConfigError(
        `cannot parse ${filename}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isObject(parsed)) {
      throw new ConfigError(`${filename} must contain a YAML object at its root`);
    }
    mergeDocument(
      merged,
      normalizeDocumentPaths(parsed, filename),
      origins,
      filename,
    );
  }

  const settings = (merged.settings ??= {}) as Record<string, unknown>;
  if (isObject(settings)) {
    settings.database ??= path.join(root, "data/conveyor.sqlite");
    settings.logs ??= path.join(root, "data/logs");
    settings.workspaces ??= path.join(root, "data/worktrees");
    settings.artifacts ??= path.join(root, "data/artifacts");
  }

  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) throw new ConfigError(formatIssues(parsed.error.issues));

  const referenceErrors = crossReferenceErrors(parsed.data);
  if (referenceErrors.length > 0) {
    throw new ConfigError(
      ["configuration references are invalid:", ...referenceErrors.map((item) => `- ${item}`)].join(
        "\n",
      ),
    );
  }

  if (registry) {
    try {
      compileRepositories(parsed.data, registry);
    } catch (error) {
      if (error instanceof PlanError) throw new ConfigError(error.message);
      throw error;
    }
  }

  return {
    ...parsed.data,
    hash: configurationHash(parsed.data),
    root,
  };
}
