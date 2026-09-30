import { TaskRegistry } from "./contract";
import { itemGroup } from "./item";
import { legacyGroup } from "./legacy";
import { workspaceGroup } from "./workspace";

/** The single place every task group is registered. */
export function createTaskRegistry(): TaskRegistry {
  const registry = new TaskRegistry();
  registry.register(itemGroup);
  registry.register(workspaceGroup);
  registry.register(legacyGroup);
  return registry;
}
