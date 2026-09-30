import { TaskRegistry } from "./contract";

/** The single place every task group is registered. */
export function createTaskRegistry(): TaskRegistry {
  return new TaskRegistry();
}
