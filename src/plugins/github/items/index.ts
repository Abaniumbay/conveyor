import type { ItemsPlugin, PluginContext } from "../../../core/plugins";
import { githubClient, type GitHubClient } from "../shared/client";
import { githubWebhookReceiver } from "./webhook";

/** GitHub Issues as the item source: today its webhook deliveries; the tracker ports join with #673. */
export const githubItemsPlugin: ItemsPlugin = {
  role: "items",
  type: "github",
  create: (context) => ({ webhook: githubWebhookReceiver(context) }),
};

/**
 * The GitHub client the service still uses for items until the tracker ports exist (#673), so this
 * returns the client rather than a port.
 */
export function githubItems(context: PluginContext): GitHubClient {
  return githubClient(context);
}
