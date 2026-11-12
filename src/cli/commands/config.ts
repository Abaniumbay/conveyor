import path from "node:path";
import { stringify } from "yaml";

import { BUILTIN_FILES } from "../../config/builtin";
import { redactSecrets } from "../../config/compose";
import { isNativeStage, STAGES_PIPELINE } from "../../config/schema";
import { ConfigError, loadConfig, type ConveyorConfig } from "../../config/load";
import { migrateConfiguration } from "../../config/migrate";
import { migrateStages } from "../../config/migrate-stages";
import { comparePlans } from "../../tasks/compare-plans";
import type { TaskRegistry } from "../../tasks/contract";
import { renderPlan } from "../../tasks/plan";
import { CliError, EXIT } from "../args";
import { loadCommandConfig, positional, printJson, stringOption, type Command } from "../command";
import { PLUGINS } from "../plugins";

/** The check report: the hash, then the expanded plan of each compilable repository. */
export async function checkConfig(configPath: string, registry?: TaskRegistry, home?: string): Promise<string> {
  const config = await loadConfig(configPath, registry, { ...(home ? { home } : {}), plugins: PLUGINS });
  return checkReport(config);
}

function checkReport(config: ConveyorConfig): string {
  const warnings = (config.warnings ?? []).map((warning) => `Warning: ${warning}`);
  const junit = Object.entries(config.repositories)
    .map(([id, repository]) => {
      const locator = repository.ci.junit;
      return locator
        ? `  ${id}: artifact "${locator.artifact}", path "${locator.path}"`
        : `  ${id}: not configured (source-link fallback)`;
    });
  return [
    `Configuration is valid (${config.hash})`,
    ...(junit.length === 0 ? [] : [`JUnit report locators:\n${junit.join("\n")}`]),
    ...warnings,
    ...(config.stages ? [stagesReport(config)] : config.plans.map(renderPlan)),
  ].join("\n\n");
}

/** The one installation-wide stage list, then per repository only its overrides and skipped stages. */
function stagesReport(config: ConveyorConfig): string {
  const stages = (config.stages ?? []).map((stage, index) => {
    const tasks = isNativeStage(stage)
      ? ` (actions: ${stage.actions.map((action) => action.id ?? action.task).join(", ") || "none"}; exit-gate: ${stage.exitGate.map((gate) => gate.id ?? gate.task).join(", ")})`
      : "";
    return `  ${index + 1}. ${stage.id}${tasks}`;
  });
  const repositories = Object.entries(config.repositories).map(([id, repository]) => {
    const overrides = Object.entries(repository.overrides?.stages ?? {});
    const skipped = overrides.filter(([, override]) => override.skip).map(([stage]) => stage);
    const changed = overrides.flatMap(([stage, override]) =>
      (["actions", "exitGate"] as const).flatMap((list) =>
        Object.keys(override[list] ?? {}).map((task) => `${stage}.${list === "exitGate" ? "exit-gate" : list}.${task}`),
      ),
    );
    return [
      `Repository ${id}`,
      `  overrides: ${changed.length > 0 ? changed.join(", ") : "none"}`,
      `  skipped stages: ${skipped.length > 0 ? skipped.join(", ") : "none"}`,
    ].join("\n");
  });
  return [`Stages (all repositories):`, ...stages, "", ...repositories.flatMap((repository) => [repository, ""])].join("\n").trimEnd();
}

export const configCheck: Command = {
  name: "config check",
  summary: "validate the configuration and print each repository's compiled plan",
  async run(context) {
    const config = await loadCommandConfig(context);
    if (context.json) {
      printJson(context, { valid: true, hash: config.hash, mode: config.mode, warnings: config.warnings ?? [], plans: config.plans });
      return;
    }
    context.out(checkReport(config));
  },
};

export const configShow: Command = {
  name: "config show",
  summary: "print the effective configuration, with !secret values redacted",
  async run(context) {
    const config = await loadCommandConfig(context, null);
    const { plans: _plans, secrets = [], warnings: _warnings, ...effective } = config;
    if (effective.stages) {
      // The stages list is carried internally as the pipeline named "stages"; show it only once.
      effective.pipelines = Object.fromEntries(Object.entries(effective.pipelines).filter(([name]) => name !== STAGES_PIPELINE));
      effective.repositories = Object.fromEntries(
        Object.entries(effective.repositories).map(([id, { pipeline, ...repository }]) => [id, pipeline === STAGES_PIPELINE ? repository : { ...repository, pipeline }]),
      ) as typeof effective.repositories;
    }
    const redacted = redactSecrets(effective, secrets);
    if (context.json) printJson(context, redacted);
    else context.out(stringify(redacted, { aliasDuplicateObjects: false, lineWidth: 0 }).trimEnd());
  },
};

export const configCompare: Command = {
  name: "config compare",
  usage: "[<left>] <right>",
  summary: "compile two configurations and compare their plans (left defaults to the current configuration)",
  async run(context) {
    const [first, second] = context.positionals;
    if (!first) throw new CliError("missing the configuration to compare with", EXIT.usage);
    const leftPath = second ? path.resolve(first) : context.paths.config;
    const rightPath = path.resolve(second ?? first);
    const [left, right] = await Promise.all([loadCommandConfig(context, undefined, leftPath), loadCommandConfig(context, undefined, rightPath)]);
    const identical = Bun.deepEquals(left.plans, right.plans, true);
    if (context.json) {
      printJson(context, { identical, left: { path: leftPath, hash: left.hash }, right: { path: rightPath, hash: right.hash } });
    } else {
      context.out([
        `Configuration is valid (${left.hash}) | Configuration is valid (${right.hash})`,
        comparePlans(left.plans, right.plans, { left: leftPath, right: rightPath }),
      ].join("\n\n"));
    }
    return identical ? EXIT.ok : EXIT.failure;
  },
};

export const configMigrate: Command = {
  name: "config migrate",
  summary: "write a tag-based conveyor.yaml reproducing a configuration directory, and verify it",
  options: {
    from: { type: "string", value: "<dir-or-file>", description: "the configuration to migrate (default: --config)" },
    to: { type: "string", value: "<dir>", description: "an absent or empty directory for the new configuration" },
    stages: { type: "boolean", description: "convert the pipelines of the configuration file into one installation-wide stages list, written beside it as *.migrated.yaml" },
  },
  details: "Instruction files are copied into the new directory; script, folder and state paths are kept as they are, so the compiled plans stay identical. Exits 1 when the result is not identical.",
  async run(context) {
    const from = path.resolve(stringOption(context, "from") ?? context.paths.config);
    if (context.options.stages === true) {
      try {
        const migrated = await migrateStages(from, { home: context.paths.home, plugins: PLUGINS });
        if (context.json) printJson(context, migrated);
        else {
          context.out([`Wrote ${migrated.output}`, ...migrated.comparisons.map((entry) => `Repository ${entry.repository}:\n${entry.report}`)].join("\n\n"));
        }
        return EXIT.ok;
      } catch (error) {
        if (error instanceof ConfigError) throw new CliError(error.message, EXIT.config);
        throw error;
      }
    }
    const to = stringOption(context, "to");
    if (!to) throw new CliError("--to is required", EXIT.usage);
    let result;
    try {
      result = await migrateConfiguration(from, to, { home: context.paths.home, plugins: PLUGINS });
    } catch (error) {
      if (error instanceof ConfigError) throw new CliError(error.message, EXIT.config);
      throw error;
    }
    const identical = result.plansIdentical && result.differences.length === 0;
    if (context.json) {
      printJson(context, { ...result, identical });
    } else {
      context.out([
        `Wrote ${result.entrypoint}`,
        ...result.written.map((file) => `  ${file}`),
        ...(result.copied.length > 0 ? ["Copied instructions:", ...result.copied.map(([source, destination]) => `  ${source} -> ${destination}`)] : []),
        `Compiled plans identical: ${result.plansIdentical ? "yes" : "NO"}`,
        `Effective configuration identical: ${result.differences.length === 0 ? "yes" : `NO (${result.differences.join(", ")})`}`,
        ...result.notes.map((note) => `Note: ${note}`),
        ...(identical ? [`Next: point Conveyor at it with --config ${result.entrypoint}, or move it to <home>/config.`] : []),
      ].join("\n"));
    }
    return identical ? EXIT.ok : EXIT.failure;
  },
};

export const configBuiltin: Command = {
  name: "config builtin",
  usage: "[<file>]",
  summary: "list the packaged defaults, or print one to copy and adapt",
  async run(context) {
    const file = context.positionals[0];
    if (!file) {
      const names = Object.keys(BUILTIN_FILES).sort();
      if (context.json) printJson(context, names);
      else context.out(names.map((name) => `builtin:${name}`).join("\n"));
      return;
    }
    const name = positional(context, 0, "file").replace(/^builtin:/, "");
    const content = BUILTIN_FILES[name];
    if (content === undefined) throw new CliError(`builtin:${name} is not a packaged default`, EXIT.usage);
    context.out(content.trimEnd());
  },
};
