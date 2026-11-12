import type { PluginContext } from "../../../core/plugins";
import { githubClient, type GitHubClient } from "../shared/client";

/**
 * GitHub Issues as the item source. Until the tracker ports exist (#673), the service still uses the
 * GitHub client itself for items, so this returns the client rather than a port.
 */
export function githubItems(context: PluginContext): GitHubClient {
  return githubClient(context);
}
