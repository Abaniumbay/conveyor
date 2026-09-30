export type ChangeAction = "ensure" | "merge";

/** Normalize the provider-neutral action names and their legacy PR aliases.
 * @deprecated `pullRequest.ensure` and `pullRequest.squashMerge` remain accepted for existing pipelines.
 */
export function changeAction(name: string): ChangeAction | null {
  if (name === "change.ensure" || name === "pullRequest.ensure") return "ensure";
  if (name === "change.merge" || name === "pullRequest.squashMerge") return "merge";
  return null;
}
