import type { GitHubAdapter } from "./adapter";

/** The source protections that apply when GitHub makes a configured repository public. */
export const publicRepositoryTrustPolicy = {
  permissionThreshold: "write, maintain, or admin",
  ignoredInputCategories: [
    "native review findings",
    "post-enrollment issue title and body edits",
    "enrollment labels",
  ],
} as const;

/** Makes the shared repository trust decision for GitHub-authored artifacts. */
export class GitHubRepositoryTrust {
  constructor(private readonly github: Pick<GitHubAdapter, "collaboratorPermission">) {}

  async isTrusted(input: { address: string; login: string | null; extraTrustedLogins: readonly string[] }): Promise<boolean> {
    if (input.login === null) return false;
    const login = input.login.toLowerCase();
    if (input.extraTrustedLogins.some((configured) => configured.toLowerCase() === login)) return true;
    const permission = await this.github.collaboratorPermission(input.address, input.login);
    return permission === "write" || permission === "maintain" || permission === "admin";
  }
}
