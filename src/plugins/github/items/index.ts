import type { ItemsPlugin, PluginContext } from "../../../core/plugins";
import type { ItemSourceConnection } from "../../../source/client";
import { githubClient } from "../shared/client";
import { githubSourceSchema } from "./config";
import { githubWebhookReceiver } from "./webhook";

/** GitHub Issues as the item source: its webhook deliveries here, its client through `githubItems`. */
export const githubItemsPlugin: ItemsPlugin = {
  role: "items",
  type: "github",
  configSchema: githubSourceSchema,
  create: (context) => ({ webhook: githubWebhookReceiver(context) }),
};

/** GitHub Issues as the service's item source: the shared GitHub client, behind the item source ports. */
export function githubItems(context: PluginContext): ItemSourceConnection {
  const { adapter, calls } = githubClient(context);
  return { client: adapter, calls };
}
