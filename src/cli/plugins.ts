// The command line is an entry point: it loads configuration with the plugins this build ships, so
// each provider entry is validated by its own plugin's schema.

import { GhCliTransport, GitHubAdapter, type GitHubTransport } from "../plugins/github/shared/adapter";

export { PLUGINS } from "../plugins";

/** How `conveyor doctor` reaches the item source; a test gives its own in place of the gh CLI. */
export type DoctorTransport = GitHubTransport;

/** The item source client `conveyor doctor` probes repositories with. */
export type DoctorItemSource = GitHubAdapter;

/**
 * The client `conveyor doctor` probes repositories with: over `transport` when given, else over
 * the gh CLI when it is installed and authenticated; null when neither can reach the source.
 */
export function doctorItemSource(transport: DoctorTransport | undefined, ghReady: boolean, labelPrefix: string): DoctorItemSource | null {
  const chosen = transport ?? (ghReady ? new GhCliTransport() : null);
  return chosen ? new GitHubAdapter(chosen, labelPrefix) : null;
}
