import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildFindingReport, isoWeek } from "../../src/app/finding-report";
import { ConveyorStore } from "../../src/db/store";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function world() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-finding-report-"));
  directories.push(root);
  const store = await ConveyorStore.open(path.join(root, "db.sqlite"));
  const db = store.sqlite();
  for (const id of ["alpha", "beta"]) {
    store.upsertRepository({ id, configName: id, source: "github", address: `owner/${id}`, folder: `/work/${id}`, configHash: "h" });
  }
  let n = 0;
  const issue = (id: string, repositoryId: string) => {
    n += 1;
    store.upsertIssue({
      id, repositoryId, sourceNumber: n, sourceUrl: `https://example.test/${n}`, title: id,
      body: "", sourceState: "open", labels: [], sourceUpdatedAt: "2026-10-01T00:00:00.000Z",
    });
  };
  const run = (id: string, issueId: string, startedAt: string, finishedAt: string | null, stage = "review") => {
    db.query("INSERT INTO runs(id, issue_id, stage_id, attempt, kind, status, config_hash, started_at, finished_at) VALUES (?, ?, ?, 1, 'reviewer', 'succeeded', 'h', ?, ?)")
      .run(id, issueId, stage, startedAt, finishedAt);
  };
  const finding = (id: string, issueId: string, o: { type?: string; author?: string; at: string; runId?: string | null; providerKey?: string | null; state?: string }) => {
    db.query("INSERT INTO findings(id, issue_id, run_id, provider_key, author, source, head_sha, state, body, created_at, type) VALUES (?, ?, ?, ?, ?, 'agent', 'sha', ?, 'b', ?, ?)")
      .run(id, issueId, o.runId ?? null, o.providerKey ?? null, o.author ?? "reviewer", o.state ?? "open", o.at, o.type ?? "general");
  };
  return { db, issue, run, finding };
}

describe("buildFindingReport", () => {
  test("counts every finding once by type, whatever its state", async () => {
    const { db, issue, finding } = await world();
    issue("a1", "alpha");
    finding("f1", "a1", { type: "bug", at: "2026-10-01T00:00:00.000Z" });
    finding("f2", "a1", { type: "bug", at: "2026-10-01T00:00:00.000Z", state: "dismissed" });
    finding("f3", "a1", { type: "security", at: "2026-10-01T00:00:00.000Z", state: "withdrawn" });
    const report = buildFindingReport(db);
    expect(report.total).toBe(3);
    expect(report.byType.bug).toBe(2);
    expect(report.byType.security).toBe(1);
    expect(report.byType.docs).toBe(0);
  });

  test("counts findings per repository", async () => {
    const { db, issue, finding } = await world();
    issue("a1", "alpha");
    issue("b1", "beta");
    finding("f1", "a1", { at: "2026-10-01T00:00:00.000Z" });
    finding("f2", "a1", { at: "2026-10-01T00:00:00.000Z" });
    finding("f3", "b1", { at: "2026-10-01T00:00:00.000Z" });
    expect(buildFindingReport(db).byRepository).toEqual({ alpha: 2, beta: 1 });
  });

  test("counts findings per stored author, including human and bot authors", async () => {
    const { db, issue, finding } = await world();
    issue("a1", "alpha");
    finding("f1", "a1", { author: "reviewer", at: "2026-10-01T00:00:00.000Z" });
    finding("f2", "a1", { author: "reviewer", at: "2026-10-01T00:00:00.000Z" });
    finding("f3", "a1", { author: "alice", at: "2026-10-01T00:00:00.000Z", providerKey: "review:1" });
    finding("f4", "a1", { author: "codex[bot]", at: "2026-10-01T00:00:00.000Z", providerKey: "review:2" });
    expect(buildFindingReport(db).byAuthor).toEqual({ reviewer: 2, alice: 1, "codex[bot]": 1 });
  });

  test("assigns findings to UTC ISO weeks across year and week boundaries", async () => {
    expect(isoWeek("2026-12-31T23:59:59.000Z")).toBe("2026-W53");
    const { db, issue, finding } = await world();
    issue("a1", "alpha");
    finding("f1", "a1", { at: "2026-10-18T23:59:59.000Z" }); // Sunday, W42
    finding("f2", "a1", { at: "2026-10-19T00:00:00.000Z" }); // Monday, W43
    finding("f3", "a1", { at: "2027-01-03T12:00:00.000Z" }); // Sunday, still 2026-W53
    finding("f4", "a1", { at: "2027-01-04T00:00:00.000Z" }); // Monday, 2027-W01
    finding("f5", "a1", { at: "2024-12-30T00:00:00.000Z" }); // Monday, 2025-W01
    expect(buildFindingReport(db).byWeek).toEqual({ "2026-W42": 1, "2026-W43": 1, "2026-W53": 1, "2027-W01": 1, "2025-W01": 1 });
  });

  test("shares count rounds with the type over all review rounds, including rounds without findings", async () => {
    const { db, issue, run, finding } = await world();
    issue("a1", "alpha");
    run("r1", "a1", "2026-10-01T00:00:00.000Z", "2026-10-01T01:00:00.000Z");
    run("r2", "a1", "2026-10-02T00:00:00.000Z", "2026-10-02T01:00:00.000Z");
    run("r3", "a1", "2026-10-03T00:00:00.000Z", "2026-10-03T01:00:00.000Z");
    run("r4", "a1", "2026-10-04T00:00:00.000Z", "2026-10-04T01:00:00.000Z");
    run("impl", "a1", "2026-10-04T00:00:00.000Z", "2026-10-04T01:00:00.000Z", "implementation");
    finding("f1", "a1", { type: "bug", runId: "r1", at: "2026-10-01T00:30:00.000Z" });
    finding("f2", "a1", { type: "bug", runId: "r1", at: "2026-10-01T00:31:00.000Z" });
    finding("f3", "a1", { type: "bug", runId: "r2", at: "2026-10-02T00:30:00.000Z" });
    finding("f4", "a1", { type: "docs", runId: "r2", at: "2026-10-02T00:30:00.000Z" });
    // Imported during r3, so r3 holds a security finding.
    finding("f5", "a1", { type: "security", providerKey: "review:9", at: "2026-10-03T00:10:00.000Z" });
    const report = buildFindingReport(db);
    const share = (type: string) => report.typeShares.find((s) => s.type === type)!;
    expect(report.reviewRounds).toBe(4);
    expect(share("bug")).toMatchObject({ findings: 3, rounds: 2, share: 0.5 });
    expect(share("docs").share).toBe(0.25);
    expect(share("security").share).toBe(0.25);
    expect(share("style").share).toBe(0);
  });

  test("filters by repository and inclusive since before aggregating, with the denominator on run start", async () => {
    const { db, issue, run, finding } = await world();
    issue("a1", "alpha");
    issue("b1", "beta");
    run("old", "a1", "2026-10-01T00:00:00.000Z", "2026-10-01T01:00:00.000Z");
    run("new", "a1", "2026-10-10T00:00:00.000Z", "2026-10-10T01:00:00.000Z");
    run("other", "b1", "2026-10-10T00:00:00.000Z", "2026-10-10T01:00:00.000Z");
    finding("f1", "a1", { type: "bug", runId: "old", at: "2026-10-01T00:30:00.000Z" });
    finding("f2", "a1", { type: "bug", runId: "new", at: "2026-10-10T00:00:00.000Z" });
    finding("f3", "b1", { type: "bug", runId: "other", at: "2026-10-10T00:30:00.000Z" });

    const scoped = buildFindingReport(db, { repositoryId: "alpha", since: "2026-10-10T00:00:00.000Z" });
    expect(scoped.total).toBe(1);
    expect(scoped.byRepository).toEqual({ alpha: 1 });
    expect(scoped.reviewRounds).toBe(1);
    expect(scoped.typeShares.find((s) => s.type === "bug")!.share).toBe(1);
    expect(buildFindingReport(db, { repositoryId: "beta" }).total).toBe(1);
    expect(buildFindingReport(db).total).toBe(3);
  });
});
