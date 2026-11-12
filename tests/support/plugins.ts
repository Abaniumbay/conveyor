import type { ConveyorConfig } from "../../src/config/load";
import { pluginContext, PluginRegistry } from "../../src/core/plugins";
import { PLUGINS } from "../../src/plugins";
import { githubClient } from "../../src/plugins/github/shared/client";
import type { GitHubAdapter } from "../../src/plugins/github/shared/adapter";
import { GitHubCallMeter } from "../../src/plugins/github/shared/call-meter";

/** The shipped plugins, with the GitHub plugins sharing the test's own GitHub client. */
export function githubPlugins(config: ConveyorConfig, github: GitHubAdapter, calls = new GitHubCallMeter()): PluginRegistry {
  const context = pluginContext(config);
  githubClient(context, () => ({ adapter: github, calls }));
  return new PluginRegistry(PLUGINS, context);
}
