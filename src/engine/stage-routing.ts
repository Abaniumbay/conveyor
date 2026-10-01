import type { Route } from "../tasks/contract";

/** A failed task's route: the result's own, else the instance's `onFail`, else the list default. */
export function resolveRoute(
  fromResult: Route | undefined,
  onFail: Route | null,
  list: "actions" | "exit-gate",
): Route {
  return fromResult ?? onFail ?? (list === "actions" ? { stop: "blocked" } : { retry: true });
}
