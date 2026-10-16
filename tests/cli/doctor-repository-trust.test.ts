import { describe, expect, test } from "bun:test";

import { repositoryTrustChecks } from "../../src/cli/commands/doctor";
import type { ConveyorConfig } from "../../src/config/load";
import { GitHubAdapter, type GitHubTransport, type GitHubTransportRequest } from "../../src/source/github/adapter";

const config = (repositories: Record<string, unknown>) => ({ repositories }) as unknown as ConveyorConfig;

function adapter(visibility: unknown, permission: unknown = "admin") {
  const transport: GitHubTransport = {
    async request<T>(request: GitHubTransportRequest): Promise<T> {
      if (request.path === "repos/owner/my-app") {
        expect(request).toEqual({ method: "GET", path: "repos/owner/my-app" });
        if (visibility instanceof Error) throw visibility;
        return visibility as T;
      }
      if (request.path === "user") {
        expect(request).toEqual({ method: "GET", path: "user" });
        return { login: "doctor-user" } as T;
      }
      expect(request).toEqual({ method: "GET", path: "repos/owner/my-app/collaborators/doctor-user/permission" });
      if (permission instanceof Error) throw permission;
      return { permission } as T;
    },
  };
  return new GitHubAdapter(transport, "conveyor");
}

describe("doctor repository trust checks", () => {
  test("reports public safeguards, the effective permission threshold, and extra trusted logins", async () => {
    const checks = await repositoryTrustChecks(
      config({ app: { address: "owner/my-app", extraTrustedLogins: ["reviewer[bot]"] } }),
      adapter({ private: false }),
    );

    expect(checks).toEqual([expect.objectContaining({
      name: "repository trust app",
      status: "ok",
      detail: expect.stringContaining("public"),
    })]);
    const detail = checks[0]!.detail;
    expect(detail).toContain("write, maintain, or admin");
    expect(detail).toContain("reviewer[bot]");
    expect(detail).toContain("native review findings");
    expect(detail).toContain("post-enrollment issue title and body edits");
    expect(detail).toContain("enrollment labels");
    expect(detail).toContain("author-permission lookups are available");
  });

  test("reports private repositories without claiming public-source protection is active", async () => {
    const checks = await repositoryTrustChecks(config({ app: { address: "owner/my-app" } }), adapter({ private: true }));

    expect(checks).toEqual([expect.objectContaining({
      status: "ok",
      detail: expect.stringContaining("private"),
    })]);
    expect(checks[0]!.detail).toContain("not required");
  });

  test("uses the authenticated user to probe author lookups for organization repositories", async () => {
    const requests: GitHubTransportRequest[] = [];
    const transport: GitHubTransport = {
      async request<T>(request: GitHubTransportRequest): Promise<T> {
        requests.push(request);
        if (request.path === "repos/organization/my-app") return { private: false } as T;
        if (request.path === "user") return { login: "doctor-user" } as T;
        if (request.path === "repos/organization/my-app/collaborators/doctor-user/permission") return { permission: "write" } as T;
        throw new Error(`Unexpected GitHub request: ${request.path}`);
      },
    };

    const checks = await repositoryTrustChecks(
      config({ app: { address: "organization/my-app" } }),
      new GitHubAdapter(transport, "conveyor"),
    );

    expect(checks[0]).toMatchObject({ status: "ok" });
    expect(requests.map((request) => request.path)).toEqual([
      "repos/organization/my-app",
      "user",
      "repos/organization/my-app/collaborators/doctor-user/permission",
    ]);
  });

  test("warns specifically when repository visibility cannot be determined", async () => {
    const checks = await repositoryTrustChecks(config({ app: { address: "owner/my-app" } }), null);

    expect(checks).toEqual([expect.objectContaining({
      status: "warn",
      detail: expect.stringContaining("cannot determine whether owner/my-app is public"),
      fix: expect.stringContaining("read access"),
    })]);
  });

  test("warns when GitHub cannot answer the visibility check", async () => {
    const checks = await repositoryTrustChecks(
      config({ app: { address: "owner/my-app" } }),
      adapter(new Error("GitHub is unavailable")),
    );

    expect(checks).toEqual([expect.objectContaining({
      status: "warn",
      detail: expect.stringContaining("GitHub is unavailable"),
    })]);
    expect(checks[0]!.detail).toContain("cannot determine whether owner/my-app is public");
  });

  test("warns when GitHub cannot confirm author-permission lookups for a public repository", async () => {
    const checks = await repositoryTrustChecks(
      config({ app: { address: "owner/my-app" } }),
      adapter({ private: false }, new Error("permission endpoint is unavailable")),
    );

    expect(checks).toEqual([expect.objectContaining({
      status: "warn",
      detail: expect.stringContaining("author-permission lookups cannot be confirmed"),
      fix: expect.stringContaining("collaborator permissions"),
    })]);
    expect(checks[0]!.detail).toContain("permission endpoint is unavailable");
  });
});
