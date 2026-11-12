import type { ConveyorConfig } from "../../src/config/load";
import { pluginContext, PluginRegistry, type Plugin } from "../../src/core/plugins";
import { PLUGINS } from "../../src/plugins";
import { githubClient } from "../../src/plugins/github/shared/client";
import type { GitHubAdapter } from "../../src/plugins/github/shared/adapter";
import { GitHubCallMeter } from "../../src/plugins/github/shared/call-meter";

/**
 * The shipped plugins, with the GitHub plugins sharing the test's own GitHub client. `overrides`
 * replace the shipped plugin of the same role and type (a fake CI provider, say).
 */
export function githubPlugins(config: ConveyorConfig, github: GitHubAdapter, calls = new GitHubCallMeter(), overrides: readonly Plugin[] = []): PluginRegistry {
  const context = pluginContext(config);
  githubClient(context, () => ({ adapter: github, calls }));
  const replaced = (plugin: Plugin) => overrides.some((override) => override.role === plugin.role && override.type === plugin.type);
  return new PluginRegistry([...PLUGINS.filter((plugin) => !replaced(plugin)), ...overrides], context);
}
