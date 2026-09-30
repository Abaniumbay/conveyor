import type { ConveyorConfig } from "../../config/load";
import { CodeHostRegistry } from "../../codehost/registry";
import { GitHubAdapter } from "./adapter";
import { GitHubCodeHost } from "./codehost";

/** Builds the GitHub registrations, including the source-backed legacy default. */
export function createGitHubCodeHostRegistry(
  config: Pick<ConveyorConfig, "codeHosts" | "sources">,
  github: GitHubAdapter,
): CodeHostRegistry {
  const registry = new CodeHostRegistry();
  for (const [name, definition] of Object.entries(config.codeHosts ?? {})) {
    if (definition.type === "github") registry.register(name, new GitHubCodeHost(github));
  }
  for (const [name, source] of Object.entries(config.sources ?? {})) {
    if (source.type === "github" && !registry.get(name)) {
      registry.register(name, new GitHubCodeHost(github));
    }
  }
  return registry;
}
