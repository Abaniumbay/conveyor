import { TaskRegistry } from "./contract";
import { agentGroup } from "./agent";
import { changeGroup } from "./change";
import { ciGroup } from "./ci";
import { conversationGroup } from "./conversation";
import { itemGroup } from "./item";
import { legacyGroup } from "./legacy";
import { scriptGroup } from "./script";
import { todoGroup } from "./todo";
import { workspaceGroup } from "./workspace";

/** The single place every task group is registered. */
export function createTaskRegistry(): TaskRegistry {
  const registry = new TaskRegistry();
  registry.register(itemGroup);
  registry.register(workspaceGroup);
  registry.register(changeGroup);
  registry.register(ciGroup);
  registry.register(agentGroup);
  registry.register(conversationGroup);
  registry.register(todoGroup);
  registry.register(scriptGroup);
  registry.register(legacyGroup);
  return registry;
}
