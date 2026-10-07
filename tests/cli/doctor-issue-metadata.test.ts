import { describe, expect, test } from "bun:test";

import { issueMetadataChecks } from "../../src/cli/commands/doctor";
import type { ConveyorConfig } from "../../src/config/load";
import { GitHubAdapter, GitHubTransportError, type GitHubTransport, type GitHubTransportRequest } from "../../src/source/github/adapter";

const config = (repositories: Record<string, unknown>) => ({ repositories }) as unknown as ConveyorConfig;
const refinement = { fields: ["Effort"], require: { type: true, fields: ["Effort"], section: true } };
const plain = { address: "o/plain", refinement: { fields: [], require: { type: false, fields: [], section: false } } };
const failure = (code: number) => new GitHubTransportError(`failed (HTTP ${code})`, 1, `gh: nope (HTTP ${code})`);

function adapter(responses: { types: unknown; fields: unknown; repository: unknown }) {
  const requests: GitHubTransportRequest[] = [];
  const transport: GitHubTransport = {
    async request<T>(request: GitHubTransportRequest): Promise<T> {
      requests.push(request);
      const result = request.path.includes("issue-types") ? responses.types : request.path.includes("issue-fields") ? responses.fields : responses.repository;
      if (result instanceof Error) throw result;
      return result as T;
    },
  };
  return { adapter: new GitHubAdapter(transport, "conveyor"), requests };
}

describe("doctor issue metadata checks", () => {
  test("a repository with full access is ok, and diagnosis only reads", async () => {
    const { adapter: github, requests } = adapter({ types: [{ name: "Bug" }], fields: [{ id: 1 }], repository: { permissions: { push: true } } });
    const checks = await issueMetadataChecks(config({ app: { address: "o/app", refinement } }), github);
    expect(checks.map((check) => [check.name, check.status])).toEqual([
      ["issue types app", "ok"], ["issue fields app", "ok"], ["issue metadata write app", "ok"],
    ]);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  test("names the repository and capability that credentials cannot read, with a fix", async () => {
    const { adapter: github } = adapter({ types: failure(403), fields: failure(403), repository: { permissions: { push: true } } });
    const checks = await issueMetadataChecks(config({ app: { address: "o/app", refinement } }), github);
    expect(checks[0]).toMatchObject({ name: "issue types app", status: "fail" });
    expect(checks[0]!.detail).toContain("cannot read issue types for o (repository o/app)");
    expect(checks[0]!.fix).toContain("read:org");
    expect(checks[1]).toMatchObject({ name: "issue fields app", status: "fail" });
  });

test("reports missing write access", async () => {
    const { adapter: github } = adapter({ types: [{ name: "Bug" }], fields: [{ id: 1 }], repository: { permissions: { push: false } } });
    const checks = await issueMetadataChecks(config({ app: { address: "o/app", refinement } }), github);
    const write = checks.find((check) => check.name === "issue metadata write app")!;
    expect(write).toMatchObject({ status: "fail" });
    expect(write.detail).toContain("cannot write issue types or issue-field values on o/app");
  expect(write.fix).toContain("issue-management access to o/app");
});

test("allows issue management without code push access", async () => {
  const { adapter: github } = adapter({ types: [{ name: "Bug" }], fields: [{ id: 1 }], repository: { permissions: { push: false, triage: true } } });
  const checks = await issueMetadataChecks(config({ app: { address: "o/app", refinement } }), github);
  expect(checks.find((check) => check.name === "issue metadata write app")).toMatchObject({ status: "ok" });
});

  test("an owner without types or fields is fine, and repositories that configure nothing are skipped", async () => {
    const { adapter: github, requests } = adapter({ types: failure(404), fields: failure(404), repository: { permissions: { push: true } } });
    const checks = await issueMetadataChecks(config({ app: { address: "o/app", refinement }, plain }), github);
    expect(checks.filter((check) => check.status === "ok").length).toBe(3);
    expect(checks[0]!.detail).toContain("defines no issue types");
    expect(checks.some((check) => check.name.endsWith("plain"))).toBe(false);
    expect(requests.every((request) => !request.path.includes("o/plain"))).toBe(true);
  });
});
