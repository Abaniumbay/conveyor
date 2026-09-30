import { TaskRegistry } from "./contract";
import { legacyGroup } from "./legacy";

/** The single place every task group is registered. */
export function createTaskRegistry(): TaskRegistry {
  const registry = new TaskRegistry();
  registry.register(legacyGroup);
  return registry;
}
