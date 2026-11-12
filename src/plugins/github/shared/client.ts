import type { PluginContext } from "../../../core/plugins";
import { CallMeter } from "../../../source/calls";
import { GhCliTransport, GitHubAdapter } from "./adapter";
import { MeteredGitHubTransport } from "./call-meter";
import { GitHubReadCache } from "./read-cache";
import { RetryingGitHubTransport } from "./retry";

/** The GitHub API client the GitHub plugins share, with the meter that counts its requests. */
export interface GitHubClient {
  adapter: GitHubAdapter;
  calls: CallMeter;
}

function createClient(context: PluginContext): GitHubClient {
  const calls = new CallMeter();
  // Reads come from the cache; the meter counts only the requests that reach GitHub.
  const transport = new GitHubReadCache(new MeteredGitHubTransport(new RetryingGitHubTransport(new GhCliTransport()), calls));
  return { adapter: new GitHubAdapter(transport, context.config.settings.labelPrefix), calls };
}

/** The one GitHub client of this service; `create` decides how it is built the first time it is asked for. */
export function githubClient(context: PluginContext, create: (context: PluginContext) => GitHubClient = createClient): GitHubClient {
  return context.shared("github", () => create(context));
}
