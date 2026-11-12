// Who may act on Conveyor's behalf through a source: Conveyor's own policy, decided from the
// permission the source reports for an actor. The source supplies the permission (`ActorPermissions`);
// the threshold is Conveyor's, so it is the same whichever source a repository uses.

/** An actor's permission on a repository, on GitHub's scale; another source maps its roles onto it. */
export type RepositoryPermission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

/** Reads an actor's permission on a repository from the source. */
export interface ActorPermissions {
  collaboratorPermission(address: string, login: string): Promise<RepositoryPermission>;
}

/** Decides whether an actor's source-authored input (enrollment, edits, review findings) is trusted. */
export interface ActorTrust {
  isTrusted(input: { address: string; login: string | null; extraTrustedLogins: readonly string[] }): Promise<boolean>;
}

/** The source protections that apply when a configured repository is public. */
export const publicRepositoryTrustPolicy = {
  permissionThreshold: "write, maintain, or admin",
  ignoredInputCategories: [
    "native review findings",
    "post-enrollment issue title and body edits",
    "enrollment labels",
  ],
} as const;

/** The shared repository trust decision: configured logins, then write permission or above. */
export class RepositoryActorTrust implements ActorTrust {
  constructor(private readonly permissions: ActorPermissions) {}

  async isTrusted(input: { address: string; login: string | null; extraTrustedLogins: readonly string[] }): Promise<boolean> {
    if (input.login === null) return false;
    const login = input.login.toLowerCase();
    if (input.extraTrustedLogins.some((configured) => configured.toLowerCase() === login)) return true;
    const permission = await this.permissions.collaboratorPermission(input.address, input.login);
    return permission === "write" || permission === "maintain" || permission === "admin";
  }
}
