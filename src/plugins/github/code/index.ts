import type { CodePlugin } from "../../../core/plugins";
import { githubClient } from "../shared/client";
import { GitHubCodeHost } from "./codehost";

/** GitHub pull requests, reviews and merges as the code host. */
export const githubCode: CodePlugin = {
  role: "code",
  type: "github",
  create: (context) => new GitHubCodeHost(githubClient(context).adapter),
};
