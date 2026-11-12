import { TaskRegistry, type TaskGroup } from "./contract";
import { agentGroup } from "./agent";
import { breakdownGroup } from "./breakdown";
import { changeGroup } from "./change";
import { ciGroup } from "./ci";
import { conversationGroup } from "./conversation";
import type { TaskDeps } from "./deps";
import { itemGroup } from "./item";
import { legacyGroup } from "./legacy";
import { operatorGroup } from "./operator";
import { scriptGroup } from "./script";
import { todoGroup } from "./todo";
import { workspaceGroup } from "./workspace";

/**
 * The native groups. Each declares the narrow dependencies it uses; typing this list with the full
 * `TaskDeps` that the executor and the MCP dispatcher pass makes the compiler prove that value
 * satisfies every group's declaration.
 */
const NATIVE_GROUPS: TaskGroup<TaskDeps>[] = [
  itemGroup,
  breakdownGroup,
  workspaceGroup,
  changeGroup,
  ciGroup,
  agentGroup,
  conversationGroup,
  todoGroup,
  scriptGroup,
  operatorGroup,
];

/** The single place every task group is registered. */
export function createTaskRegistry(): TaskRegistry {
  const registry = new TaskRegistry();
  for (const group of NATIVE_GROUPS) registry.register(group);
  // Legacy stages run on the pipeline runtime, not on TaskDeps.
  registry.register(legacyGroup);
  return registry;
}
