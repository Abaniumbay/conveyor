import path from "node:path";
import { stringify } from "yaml";

import { BUILTIN_FILES } from "../../config/builtin";
import { redactSecrets } from "../../config/compose";
import { ConfigError, loadConfig, type ConveyorConfig } from "../../config/load";
import { migrateConfiguration } from "../../config/migrate";
import { comparePlans } from "../../tasks/compare-plans";
import type { TaskRegistry } from "../../tasks/contract";
import { renderPlan } from "../../tasks/plan";
import { CliError, EXIT } from "../args";
import { loadCommandConfig, positional, printJson, stringOption, type Command } from "../command";

/** The check report: the hash, then the expanded plan of each compilable repository. */
export async function checkConfig(configPath: string, registry?: TaskRegistry, home?: string): Promise<string> {
  const config = await loadConfig(configPath, registry, home ? { home } : {});
  return checkReport(config);
}

function checkReport(config: ConveyorConfig): string {
  return [`Configuration is valid (${config.hash})`, ...config.plans.map(renderPlan)].join("\n\n");
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
  },
  details: "Instruction files are copied into the new directory; script, folder and state paths are kept as they are, so the compiled plans stay identical. Exits 1 when the result is not identical.",
  async run(context) {
    const from = path.resolve(stringOption(context, "from") ?? context.paths.config);
    const to = stringOption(context, "to");
    if (!to) throw new CliError("--to is required", EXIT.usage);
    let result;
    try {
      result = await migrateConfiguration(from, to, { home: context.paths.home });
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
