import type { CiPlugin } from "../../../core/plugins";
import { githubClient } from "../shared/client";
import { GitHubActionsCiProvider, parseGitHubActionsTriggers } from "./actions";
import { githubActionsSchema } from "./config";

/** GitHub Actions as the CI provider. */
export const githubActions: CiPlugin = {
  role: "ci",
  type: "github-actions",
  configSchema: githubActionsSchema,
  create(context, { providerName, provider, stageInput }) {
    // A named provider's triggers win; a legacy stage may still configure them on its CI task.
    const configured = Array.isArray(provider?.triggers) ? provider.triggers : [];
    const triggers = parseGitHubActionsTriggers(
      configured.length > 0 ? configured : stageInput?.triggers,
      configured.length > 0 ? `ci.${providerName}.triggers` : "pullRequest.awaitChecks.with.triggers",
    );
    return new GitHubActionsCiProvider(githubClient(context).adapter, triggers);
  },
};
