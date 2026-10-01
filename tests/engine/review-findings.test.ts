import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorStore } from "../../src/db/store";
import { ReviewFindings, type NativeArtifact } from "../../src/engine/review-findings";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function open() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-findings-"));
  directories.push(root);
  const store = await ConveyorStore.open(path.join(root, "db.sqlite"));
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "o/r", folder: "/f", configHash: "h" });
  store.upsertIssue({
    id: "i1", repositoryId: "repo", sourceNumber: 7, sourceUrl: "u", title: "t", body: "", sourceState: "open",
    labels: [], sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  return new ReviewFindings(store.sqlite());
}

const created = { issueId: "i1", runId: "run1", author: "reviewer", headSha: "h1", path: "a.ts", line: 3, body: "Fix this" };
const artifact = (over: Partial<NativeArtifact> = {}): NativeArtifact => ({
  providerKey: "thread:T1", author: "alice", body: "Please rename", url: "https://x/c1", path: "b.ts", line: 9, resolved: false, ...over,
});

describe("ReviewFindings", () => {
  test("creates an open agent finding and records a created event", async () => {
    const findings = await open();
    const finding = findings.create(created);
    expect(finding).toMatchObject({ state: "open", source: "agent", author: "reviewer", headSha: "h1", path: "a.ts", line: 3, providerKey: null, url: "" });
    expect(findings.list("i1")).toHaveLength(1);
    expect(findings.events(finding.id).map((e) => [e.kind, e.actor])).toEqual([["created", "reviewer"]]);
  });

  test("resolve moves open to resolved once and audits it; a second resolve changes nothing", async () => {
    const findings = await open();
    const { id } = findings.create(created);
    expect(findings.resolve("i1", id, "kaveh", "t1")).toBe(true);
    expect(findings.resolve("i1", id, "kaveh", "t2")).toBe(false);
    expect(findings.get("i1", id)!.state).toBe("resolved");
    expect(findings.events(id).map((e) => e.kind)).toEqual(["created", "resolved"]);
  });

  test("dismiss records actor, reason and time; a resolved finding cannot be dismissed", async () => {
    const findings = await open();
    const a = findings.create(created);
    const b = findings.create(created);
    findings.resolve("i1", b.id, "kaveh");
    expect(findings.dismiss("i1", a.id, { actor: "human:amir", reason: "not applicable", at: "t9" })).toBe(true);
    expect(findings.dismiss("i1", b.id, { actor: "human:amir", reason: "x", at: "t9" })).toBe(false);
    expect(findings.get("i1", a.id)).toMatchObject({ state: "dismissed", dismissal: { actor: "human:amir", reason: "not applicable", at: "t9" } });
    expect(findings.events(a.id).at(-1)).toMatchObject({ kind: "dismissed", actor: "human:amir", reason: "not applicable" });
  });

  test("counts findings created by a run", async () => {
    const findings = await open();
    findings.create(created);
    findings.create({ ...created, runId: "other" });
    expect(findings.countForRun("run1")).toBe(1);
    findings.resolve("i1", findings.list("i1")[0]!.id, "kaveh");
    expect(findings.countForRun("run1")).toBe(0);
  });

  test("the provider is authoritative: an unresolved artifact reopens resolved and withdrawn findings, never dismissed ones", async () => {
    const findings = await open();
    findings.importNative("i1", [artifact(), artifact({ providerKey: "thread:T2" }), artifact({ providerKey: "thread:T3" })], "h1", "t1");
    findings.importNative("i1", [artifact({ resolved: true }), artifact({ providerKey: "thread:T3" })], "h1", "t2");
    const by = () => Object.fromEntries(findings.list("i1").map((f) => [f.providerKey, f]));
    expect(by()["thread:T1"]!.state).toBe("resolved");
    expect(by()["thread:T2"]!.state).toBe("withdrawn");
    findings.dismiss("i1", by()["thread:T3"]!.id, { actor: "human:amir", reason: "fine", at: "t3" });
    findings.importNative("i1", [artifact(), artifact({ providerKey: "thread:T2" }), artifact({ providerKey: "thread:T3" })], "h1", "t4");
    expect(by()["thread:T1"]!.state).toBe("open");
    expect(by()["thread:T2"]).toMatchObject({ state: "open" });
    expect(by()["thread:T2"]!.withdrawal).toBeUndefined();
    expect(by()["thread:T3"]!.state).toBe("dismissed");
    expect(findings.events(by()["thread:T1"]!.id).map((e) => e.kind)).toEqual(["created", "resolved", "reopened"]);
  });

  test("import creates open human findings, dedupes by provider key and updates edits", async () => {
    const findings = await open();
    findings.importNative("i1", [artifact()], "h1", "t1");
    findings.importNative("i1", [artifact()], "h1", "t2");
    expect(findings.list("i1")).toHaveLength(1);
    expect(findings.list("i1")[0]).toMatchObject({ source: "human", author: "alice", state: "open", providerKey: "thread:T1", headSha: "h1", url: "https://x/c1", path: "b.ts", line: 9 });
    findings.importNative("i1", [artifact({ body: "Please rename it" })], "h2", "t3");
    const [finding] = findings.list("i1");
    expect(finding!.headSha).toBe("h1");
    expect(findings.events(finding!.id).map((e) => e.kind)).toEqual(["created", "edited"]);
  });

  test("import resolves a finding whose thread was resolved, and withdraws a vanished one", async () => {
    const findings = await open();
    findings.importNative("i1", [artifact(), artifact({ providerKey: "thread:T2", url: "https://x/c2" })], "h1", "t1");
    findings.importNative("i1", [artifact({ resolved: true })], "h1", "t2");
    const byKey = Object.fromEntries(findings.list("i1").map((f) => [f.providerKey, f]));
    expect(byKey["thread:T1"]!.state).toBe("resolved");
    expect(byKey["thread:T2"]).toMatchObject({ state: "withdrawn", withdrawal: { actor: "provider", reason: "provider-artifact-deleted", at: "t2" } });
    expect(findings.events(byKey["thread:T2"]!.id).at(-1)!.kind).toBe("withdrawn");
  });

  test("import never touches dismissed findings or agent findings without a provider key", async () => {
    const findings = await open();
    findings.importNative("i1", [artifact()], "h1", "t1");
    const imported = findings.list("i1")[0]!;
    findings.dismiss("i1", imported.id, { actor: "human:amir", reason: "fine", at: "t2" });
    const agent = findings.create(created);
    findings.importNative("i1", [artifact({ resolved: true })], "h1", "t3");
    findings.importNative("i1", [], "h1", "t4");
    expect(findings.get("i1", imported.id)!.state).toBe("dismissed");
    expect(findings.get("i1", agent.id)!.state).toBe("open");
  });
});
