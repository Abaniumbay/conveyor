import { CryptoHasher } from "bun";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import type { ZodIssue } from "zod";

import { createTaskRegistry } from "../tasks/catalogue";
import type { TaskRegistry } from "../tasks/contract";
import { compileRepositories, PlanError, type CompiledPipeline } from "../tasks/plan";

import { builtinResolver } from "./builtin";
import { composeConfig, originOf, type ConfigOrigin } from "./compose";
import { ConfigError } from "./errors";
import { materialiseImport, parseImportSpec, type ImportSpec, type ResolvedImport } from "./import";
import { normalizeRoleDocuments } from "./roles";
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

/** How the configuration was given: a single entrypoint file, or a deprecated directory of files. */
export type ConfigMode = "entrypoint" | "directory";

export interface ConveyorConfig extends ConveyorConfigData {
  hash: string;
  root: string;
  /** Compiled plans of the native-only repositories (empty when compilation is skipped). */
  plans: CompiledPipeline[];
  /** The pinned reference-configuration import, when the local files declare one. */
  import?: Pick<ResolvedImport, "repository" | "ref" | "path" | "sha">;
  mode?: ConfigMode;
  /** Values that came from `!secret`; never display or export them. */
  secrets?: string[];
  /** Deprecations and other non-fatal findings, for the operator. */
  warnings?: string[];
}

export interface LoadConfigOptions {
  /**
   * The Conveyor home. With it, an entrypoint's unset settings paths default to the home layout
   * (`state/conveyor.sqlite`, `logs`, `worktrees`, `artifacts`) and `builtin:` includes are
   * materialised under `state/builtin`.
   */
  home?: string;
}

export { ConfigError };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvePath(value: unknown, baseDirectory: string): unknown {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) {
    return value;
  }
  if (value === "~" || value.startsWith("~/")) return path.join(homedir(), value.slice(1));
  return path.resolve(baseDirectory, value);
}

/** The directory relative paths resolve against, for a value at the given key path. */
type BaseDirectory = (segments: readonly string[]) => string;

function resolveScriptWith(holder: unknown, base: string): void {
  if (isObject(holder) && isObject(holder.with) && "script" in holder.with) {
    holder.with.script = resolvePath(holder.with.script, base);
  }
}

function normalizeDocumentPaths(
  input: ConfigurationDocument,
  baseOf: BaseDirectory,
): ConfigurationDocument {
  const document = structuredClone(input);

  if (isObject(document.settings)) {
    for (const key of ["database", "logs", "workspaces", "artifacts"] as const) {
      if (key in document.settings) {
        document.settings[key] = resolvePath(document.settings[key], baseOf(["settings", key]));
      }
    }
  }

  if (isObject(document.web) && isObject(document.web.steering)) {
    if ("workspace" in document.web.steering) {
      document.web.steering.workspace = resolvePath(
        document.web.steering.workspace,
        baseOf(["web", "steering", "workspace"]),
      );
    }
  }

  if (isObject(document.agents)) {
    for (const [name, agent] of Object.entries(document.agents)) {
      if (isObject(agent) && "instructions" in agent) {
        agent.instructions = resolvePath(agent.instructions, baseOf(["agents", name, "instructions"]));
      }
    }
  }

  if (isObject(document.checks)) {
    for (const [name, check] of Object.entries(document.checks)) {
      if (isObject(check) && "script" in check) {
        check.script = resolvePath(check.script, baseOf(["checks", name, "script"]));
      }
    }
  }

  if (isObject(document.pipelines)) {
    for (const [name, pipeline] of Object.entries(document.pipelines)) {
      if (!isObject(pipeline) || !Array.isArray(pipeline.stages)) continue;
      for (const [index, stage] of pipeline.stages.entries()) {
        if (!isObject(stage)) continue;
        const stagePath = ["pipelines", name, "stages", String(index)];
        if (isObject(stage.run) && "script" in stage.run) {
          stage.run.script = resolvePath(stage.run.script, baseOf([...stagePath, "run", "script"]));
        }
        for (const group of ["actions", "exit-gate"] as const) {
          const list = stage[group];
          if (!Array.isArray(list)) continue;
          for (const [position, entry] of list.entries()) {
            if (isObject(entry) && entry.task === "script.run") {
              resolveScriptWith(entry, baseOf([...stagePath, group, String(position), "with", "script"]));
            }
          }
        }
      }
    }
  }

  if (isObject(document.repositories)) {
    for (const [name, repository] of Object.entries(document.repositories)) {
      if (isObject(repository) && "folder" in repository) {
        repository.folder = resolvePath(repository.folder, baseOf(["repositories", name, "folder"]));
      }
      if (isObject(repository) && isObject(repository.overrides) && isObject(repository.overrides.stages)) {
        for (const [stageId, stage] of Object.entries(repository.overrides.stages)) {
          if (!isObject(stage)) continue;
          for (const group of ["actions", "exit-gate"] as const) {
            const overrides = stage[group];
            if (!isObject(overrides)) continue;
            for (const [taskId, override] of Object.entries(overrides)) {
              resolveScriptWith(override, baseOf(["repositories", name, "overrides", "stages", stageId, group, taskId, "with", "script"]));
            }
          }
        }
      }
    }
  }

  return document;
}

async function configurationFiles(target: string): Promise<string[]> {
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

/** A validation error at a key path of the merged (internal-name) configuration. */
interface LocatedError {
  path: readonly string[];
  message: string;
}

/** Formats errors; with a locator, each names the file that defined the value and its key path there. */
type Locate = (segments: readonly string[]) => { file: string; path: readonly string[] } | null;

function formatErrors(heading: string, errors: readonly LocatedError[], locate: Locate | null): string {
  return [
    heading,
    ...errors.map((error) => {
      const located = locate?.(error.path);
      if (!located) return `- ${error.path.map(String).join(".") || "configuration"}${error.message}`;
      const keys = located.path.length > 0 ? `: ${located.path.join(".")}` : "";
      return `- ${located.file}${keys}${error.message}`;
    }),
  ].join("\n");
}

function zodErrors(issues: readonly ZodIssue[]): LocatedError[] {
  return issues.map((issue) => ({ path: issue.path.map(String), message: `: ${issue.message}` }));
}

function crossReferenceErrors(config: ConveyorConfigData): LocatedError[] {
  const errors: LocatedError[] = [];
  const error = (segments: readonly (string | number)[], message: string) =>
    errors.push({ path: segments.map(String), message: ` ${message}` });
  if (config.web.steering && !config.agents[config.web.steering.agent]) {
    error(["web", "steering", "agent"], `references unknown agent "${config.web.steering.agent}"`);
  }
  for (const [name, agent] of Object.entries(config.agents)) {
    const runner = config.runners[agent.runner];
    if (!runner) {
      error(["agents", name, "runner"], `references unknown runner "${agent.runner}"`);
    } else if (runner.type === "claude-code" && agent.workspaceAccess === "workspace-write" && !agent.network) {
      // The Claude CLI needs the network for its own API calls, so its commands cannot be cut off from it.
      error(["agents", name], "runs on Claude Code with access: workspace-write, which needs network: true (its commands cannot be kept off the network yet)");
    } else if (runner.type === "claude-code" && agent.workspaceAccess === "read-only" && agent.writableRoots.length > 0) {
      error(["agents", name], "is read-only, so writableRoots does not apply");
    } else if (runner.type === "claude-code" && Object.keys(agent.codexConfig).length > 0) {
      error(["agents", name], "runs on Claude Code, which does not take codexConfig");
    }
  }
  for (const [name, check] of Object.entries(config.checks)) {
    if (!config.agents[check.verifier]) {
      error(["checks", name, "verifier"], `references unknown agent "${check.verifier}"`);
    }
  }
  for (const [pipelineName, pipeline] of Object.entries(config.pipelines)) {
    for (const [index, stage] of pipeline.stages.entries()) {
      const prefix = ["pipelines", pipelineName, "stages", index];
      if (isNativeStage(stage)) {
        if (stage.childrenStartAt && stage.childrenStartAt !== "next") {
          if (!pipeline.stages.some((candidate) => candidate.id === stage.childrenStartAt)) {
            error([...prefix, "childrenStartAt"], `references unknown stage "${stage.childrenStartAt}"`);
          }
        }
        continue;
      }
      if (stage.enterCheck && !config.checks[stage.enterCheck]) {
        error([...prefix, "enterCheck"], `references unknown check "${stage.enterCheck}"`);
      }
      if (stage.exitCheck && !config.checks[stage.exitCheck]) {
        error([...prefix, "exitCheck"], `references unknown check "${stage.exitCheck}"`);
      }
      if (stage.run.type === "agent" && !config.agents[stage.run.agent]) {
        error([...prefix, "run", "agent"], `references unknown agent "${stage.run.agent}"`);
      }
      if (stage.run.type === "script" && !config.runners[stage.run.runner]) {
        error([...prefix, "run", "runner"], `references unknown runner "${stage.run.runner}"`);
      }
      if (stage.run.type === "source-action" && stage.run.input?.triggers !== undefined && stage.run.action === "ci.await") {
        error([...prefix, "run", "with", "triggers"], "is only supported by the deprecated pullRequest.awaitChecks action");
      }
      if (stage.run.type === "source-action" && stage.run.input?.triggers !== undefined) {
        const triggers = stage.run.input.triggers;
        if (!Array.isArray(triggers)) error([...prefix, "run", "with", "triggers"], "must be a list");
        else triggers.forEach((trigger, triggerIndex) => {
          const triggerPath = [...prefix, "run", "with", "triggers", triggerIndex];
          if (!isObject(trigger)) {
            error(triggerPath, "must be an object");
            return;
          }
          if (typeof trigger.label !== "string" || !trigger.label) error([...triggerPath, "label"], "must be a non-empty string");
          if (typeof trigger.workflow !== "string" || !/^[\w.-]+\.ya?ml$/.test(trigger.workflow)) error([...triggerPath, "workflow"], "must be a workflow file name");
          if (typeof trigger.check !== "string" || !trigger.check) error([...triggerPath, "check"], "must be a non-empty string");
          if (trigger.replaces !== undefined && (!Array.isArray(trigger.replaces) || trigger.replaces.some((name) => typeof name !== "string" || !name))) {
            error([...triggerPath, "replaces"], "must be a list of names");
          }
        });
      }
      const stageIndex = pipeline.stages.indexOf(stage);
      for (const [status, policy] of Object.entries(stage.failurePolicies)) {
        if (!policy.stage) continue;
        const targetIndex = pipeline.stages.findIndex((candidate) => candidate.id === policy.stage);
        if (targetIndex < 0 || targetIndex >= stageIndex) {
          error([...prefix, "failurePolicies", status, "stage"], `must name an earlier stage, not "${policy.stage}"`);
        }
      }
      if (stage.childrenStartAt && stage.childrenStartAt !== "next") {
        if (!pipeline.stages.some((candidate) => candidate.id === stage.childrenStartAt)) {
          error([...prefix, "childrenStartAt"], `references unknown stage "${stage.childrenStartAt}"`);
        }
      }
    }
  }
  for (const [name, repository] of Object.entries(config.repositories)) {
    if (!config.sources[repository.source]) {
      error(["repositories", name, "source"], `references unknown source "${repository.source}"`);
    }
    if (!config.pipelines[repository.pipeline]) {
      error(["repositories", name, "pipeline"], `references unknown pipeline "${repository.pipeline}"`);
    }
    const ciName = repository.ci.provider;
    if (ciName && !config.ci[ciName]) {
      error(["repositories", name, "ci"], `references unknown CI provider "${ciName}"`);
    }
    if (ciName && config.ci[ciName]?.type !== "github-actions" && config.sources[repository.source]?.type === "github") {
      error(["repositories", name, "ci"], `is incompatible with sources.${repository.source}`);
    }
    {
      const providerName = ciName;
      const provider = providerName ? config.ci[providerName] : undefined;
      for (const [index, stage] of config.pipelines[repository.pipeline]?.stages.entries() ?? []) {
        if (isNativeStage(stage) || stage.run.type !== "source-action" || stage.run.input?.triggers === undefined) continue;
        if (provider && provider.triggers.length > 0) error(["pipelines", repository.pipeline, "stages", index, "run", "with", "triggers"], `conflicts with ci.${providerName}.triggers`);
      }
    }
    const codeHost = repository.codeHost ?? repository.source;
    if (config.codeHosts[codeHost]) continue;
    if (codeHost === repository.source && config.sources[repository.source]?.type === "github") continue;
    error(["repositories", name, "codeHost"], `references unknown or unsupported code host "${codeHost}"`);
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

function configurationHash(config: ConveyorConfigData, pinnedSha?: string): string {
  const hasher = new CryptoHasher("sha256");
  hasher.update(JSON.stringify(stableValue(pinnedSha ? { config, importSha: pinnedSha } : config)));
  return hasher.digest("hex");
}

async function readDocument(filename: string): Promise<ConfigurationDocument> {
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
  return parsed;
}

/** Internal section and key names, mapped back to the canonical names an entrypoint may use. */
const CANONICAL_SECTIONS: Record<string, readonly string[]> = {
  sources: ["providers", "items"],
  codeHosts: ["providers", "code"],
  ci: ["providers", "ci"],
  runners: ["harnesses"],
};
const CANONICAL_KEYS: Record<string, Record<string, string>> = {
  agents: { runner: "harness", workspaceAccess: "access" },
  repositories: { source: "items", codeHost: "code" },
};

/** Maps a key path of the merged configuration to the file that defined it and the path inside that file. */
function entrypointLocator(entrypoint: string, document: ConfigurationDocument, origins: readonly ConfigOrigin[]): Locate {
  const display = (file: string) => {
    const relative = path.relative(path.dirname(entrypoint), file);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
  };
  return (segments) => {
    let translated = [...segments];
    const section = segments[0];
    if (section && CANONICAL_SECTIONS[section]) {
      const canonical = CANONICAL_SECTIONS[section]!;
      const usesCanonical = canonical[0] === "providers" ? isObject(document.providers) : canonical[0]! in document;
      if (usesCanonical) translated = [...canonical, ...segments.slice(1)];
    }
    if (section && CANONICAL_KEYS[section] && segments.length >= 3) {
      const name = segments[1]!;
      const key = segments[2]!;
      const canonical = CANONICAL_KEYS[section]![key];
      const entry = isObject(document[section]) ? (document[section] as ConfigurationDocument)[name] : undefined;
      if (canonical && isObject(entry) && canonical in entry) translated[2] = canonical;
    }
    const origin = originOf(origins, translated);
    if (!origin) return null;
    return { file: display(origin.file), path: translated.slice((origin.root ?? origin.path).length) };
  };
}

function applySettingsDefaults(merged: ConfigurationDocument, defaults: Record<"database" | "logs" | "workspaces" | "artifacts", string>): void {
  const settings = (merged.settings ??= {}) as Record<string, unknown>;
  if (!isObject(settings)) return;
  for (const [key, value] of Object.entries(defaults)) settings[key] ??= value;
}

/** The default state locations inside a Conveyor home. */
export function homeLayout(home: string): Record<"database" | "logs" | "workspaces" | "artifacts", string> {
  return {
    database: path.join(home, "state/conveyor.sqlite"),
    logs: path.join(home, "logs"),
    workspaces: path.join(home, "worktrees"),
    artifacts: path.join(home, "artifacts"),
  };
}

export async function loadConfig(
  target: string,
  /** Pass null to validate the schema only, without compiling task plans. */
  registry: TaskRegistry | null = createTaskRegistry(),
  options: LoadConfigOptions = {},
): Promise<ConveyorConfig> {
  const resolvedTarget = path.resolve(target);
  const targetStat = await stat(resolvedTarget).catch(() => undefined);
  if (!targetStat) throw new ConfigError(`configuration path does not exist: ${resolvedTarget}`);
  if (!targetStat.isFile() && !targetStat.isDirectory()) {
    throw new ConfigError(`configuration path is not a file or directory: ${resolvedTarget}`);
  }
  const mode: ConfigMode = targetStat.isDirectory() ? "directory" : "entrypoint";
  const root = mode === "directory" ? resolvedTarget : path.dirname(resolvedTarget);
  const warnings: string[] = [];
  let secrets: string[] = [];
  let locate: Locate | null = null;

  /** Each local document with the directory its relative paths resolve against. */
  let rawLocal: { filename: string; document: ConfigurationDocument; baseOf: BaseDirectory }[];
  if (mode === "directory") {
    warnings.push(
      `loading a configuration directory is deprecated: use a single conveyor.yaml entrypoint with !include tags (\`conveyor config migrate --from ${resolvedTarget} --to <new-config-directory>\` writes one)`,
    );
    const files = await configurationFiles(resolvedTarget);
    if (files.length === 0) {
      throw new ConfigError(`no YAML configuration files found in ${resolvedTarget}`);
    }
    rawLocal = [];
    for (const filename of files) {
      const directory = path.dirname(filename);
      rawLocal.push({ filename, document: await readDocument(filename), baseOf: () => directory });
    }
  } else {
    const builtin = options.home ? builtinResolver(path.join(options.home, "state/builtin")) : undefined;
    const composed = await composeConfig(resolvedTarget, builtin ? { builtin } : {});
    secrets = composed.secrets;
    const originBase: BaseDirectory = (segments) =>
      path.dirname(originOf(composed.origins, segments)?.file ?? resolvedTarget);
    rawLocal = [{ filename: resolvedTarget, document: composed.document, baseOf: originBase }];
    if (composed.origins.length > 1) locate = entrypointLocator(resolvedTarget, composed.document, composed.origins);
  }

  // Materialised imports live under <settings.artifacts>/config-imports, which may sit inside the
  // configuration directory; skip exactly those copies. Only files outside any config-imports
  // directory may declare the artifacts path that identifies them.
  const artifactDirectories = rawLocal
    .filter(({ filename }) => !filename.split(path.sep).includes("config-imports"))
    .map(({ document, baseOf }) => {
      const resolved = isObject(document.settings)
        ? resolvePath(document.settings.artifacts, baseOf(["settings", "artifacts"]))
        : undefined;
      return typeof resolved === "string" && path.isAbsolute(resolved) ? resolved : undefined;
    })
    .filter((value): value is string => value !== undefined);
  const copies = artifactDirectories.map((directory) => path.join(directory, "config-imports") + path.sep);
  const localDocuments = rawLocal.filter(({ filename }) => !copies.some((copy) => filename.startsWith(copy)));

  let importSpec: ImportSpec | undefined;
  let importOrigin = "";
  for (const { filename, document } of localDocuments) {
    if (!("import" in document)) continue;
    if (importSpec) {
      throw new ConfigError(`only one configuration file may declare import; found it in ${importOrigin} and ${filename}`);
    }
    importSpec = parseImportSpec(document.import, filename);
    importOrigin = filename;
    delete document.import;
  }

  let resolvedImport: ResolvedImport | undefined;
  const importedRaw: { filename: string; document: ConfigurationDocument; baseOf: BaseDirectory }[] = [];
  if (importSpec) {
    warnings.push(`${importOrigin}: import is deprecated: include the packaged defaults with \`!include builtin:<file>\` instead`);
    const artifacts = artifactDirectories[0];
    if (!artifacts) {
      throw new ConfigError(
        `import in ${importOrigin} needs settings.artifacts defined in a local configuration file: imported files are materialised under <artifacts>/config-imports`,
      );
    }
    resolvedImport = await materialiseImport(importSpec, artifacts);
    for (const filename of resolvedImport.yamlFiles) {
      const document = await readDocument(filename);
      if ("import" in document) throw new ConfigError(`${filename}: an imported file cannot declare import`);
      const directory = path.dirname(filename);
      importedRaw.push({ filename, document, baseOf: () => directory });
    }
  }

  const sources = [...importedRaw, ...localDocuments];
  const documents = normalizeRoleDocuments(sources).map(({ filename, document }, index) => ({
    filename,
    document: normalizeDocumentPaths(document, sources[index]!.baseOf),
  }));

  const merged: ConfigurationDocument = {};
  const origins = new Map<string, string>();
  for (const { filename, document } of documents) {
    mergeDocument(merged, document, origins, filename);
  }

  applySettingsDefaults(
    merged,
    mode === "entrypoint" && options.home
      ? homeLayout(options.home)
      : {
          database: path.join(root, "data/conveyor.sqlite"),
          logs: path.join(root, "data/logs"),
          workspaces: path.join(root, "data/worktrees"),
          artifacts: path.join(root, "data/artifacts"),
        },
  );

  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError(formatErrors("configuration is invalid:", zodErrors(parsed.error.issues), locate));
  }

  const referenceErrors = crossReferenceErrors(parsed.data);
  if (referenceErrors.length > 0) {
    throw new ConfigError(formatErrors("configuration references are invalid:", referenceErrors, locate));
  }

  let plans: CompiledPipeline[] = [];
  if (registry) {
    try {
      plans = compileRepositories(parsed.data, registry);
    } catch (error) {
      if (error instanceof PlanError) throw new ConfigError(error.message);
      throw error;
    }
  }

  return {
    ...parsed.data,
    hash: configurationHash(parsed.data, resolvedImport?.sha),
    root,
    plans,
    mode,
    secrets,
    warnings,
    ...(resolvedImport
      ? { import: { repository: resolvedImport.repository, ref: resolvedImport.ref, path: resolvedImport.path, sha: resolvedImport.sha } }
      : {}),
  };
}
