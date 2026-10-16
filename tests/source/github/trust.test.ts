import { describe, expect, test } from "bun:test";

import { GitHubRepositoryTrust } from "../../../src/source/github/trust";

describe("GitHubRepositoryTrust", () => {
  test("trusts write-level permissions and configured logins case-insensitively", async () => {
    const lookedUp: string[] = [];
    const permissions = new Map<string, "admin" | "maintain" | "write" | "triage" | "read" | "none">([
      ["writer", "write"], ["maintainer", "maintain"], ["admin", "admin"],
      ["reader", "read"], ["triager", "triage"], ["outsider", "none"],
    ] as const);
    const trust = new GitHubRepositoryTrust({
      async collaboratorPermission(_address, login) {
        lookedUp.push(login);
        return permissions.get(login) ?? "none";
      },
    });

    for (const login of ["writer", "maintainer", "admin"]) {
      expect(await trust.isTrusted({ address: "owner/repository", login, extraTrustedLogins: [] })).toBe(true);
    }
    for (const login of ["reader", "triager", "outsider"]) {
      expect(await trust.isTrusted({ address: "owner/repository", login, extraTrustedLogins: [] })).toBe(false);
    }
    expect(await trust.isTrusted({ address: "owner/repository", login: "ReviewBot", extraTrustedLogins: ["reviewbot"] })).toBe(true);
    expect(await trust.isTrusted({ address: "owner/repository", login: null, extraTrustedLogins: ["missing-author"] })).toBe(false);
    expect(lookedUp).not.toContain("ReviewBot");
  });

  test("propagates unavailable permission data instead of treating it as untrusted", async () => {
    const trust = new GitHubRepositoryTrust({
      async collaboratorPermission() { throw new Error("GitHub unavailable"); },
    });
    await expect(trust.isTrusted({ address: "owner/repository", login: "writer", extraTrustedLogins: [] })).rejects.toThrow("GitHub unavailable");
  });
});
