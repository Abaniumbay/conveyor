import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";

import { runCli } from "../../src/cli/main";
import type { CompiledPipeline, CompiledStage, CompiledTask } from "../../src/tasks/plan";
import { comparePlans } from "../../src/tasks/compare-plans";
import { referenceConfigDirectory } from "../config/reference-fixture";

const LEGACY = path.resolve(import.meta.dir, "../fixtures/legacy-pipeline");
const CLI = path.resolve(import.meta.dir, "../../src/cli.ts");

const bases: string[] = [];
afterEach(async () => {
  await Promise.all(bases.splice(0).map((base) => rm(base, { recursive: true, force: true })));
});

function task(id: string, name: string, extra: Partial<CompiledTask> = {}): CompiledTask {
  return { id, task: name, kind: "check", with: {}, wait: { timeoutMs: 1_800_000, pollMs: 60_000 }, onFail: null, reads: [], writes: [], invalidates: [], implicitLoads: [], ...extra };
}

function stage(id: string, actions: CompiledTask[], exitGate: CompiledTask[], extra: Partial<CompiledStage> = {}): CompiledStage {
  return { id, concurrency: 1, retries: 2, childrenStartAt: null, legacy: false, actions, exitGate, ...extra };
}

function plan(repositoryId: string, stages: CompiledStage[]): CompiledPipeline {
  return { id: "delivery", repositoryId, stages };
}

describe("comparePlans", () => {
  test("reports added, removed and changed tasks, with routes and waits", () => {
    const left = plan("repo", [
      stage("review", [task("review", "agent.run", { kind: "act" })], [
        task("findings", "change.findingsResolved"),
        task("mergeable", "change.mergeable", { wait: { timeoutMs: 1_800_000, pollMs: 60_000 }, onFail: { return: "implementation" } }),
        task("old", "change.merged"),
      ]),
      stage("gone", [], [task("x", "workspace.removed")]),
    ]);
    const right = plan("repo", [
      stage("review", [task("review", "agent.run", { kind: "act" })], [
        task("findings", "change.findingsResolved", { onFail: { return: "implementation" } }),
        task("mergeable", "change.mergeable", { wait: { timeoutMs: 3_600_000, pollMs: 60_000 }, onFail: { return: "implementation" } }),
        task("criteriaApproved", "change.criteriaChecked"),
      ], { concurrency: 2 }),
    ]);
    const out = comparePlans([left], [right], { left: "A", right: "B" });
    expect(out).toContain("Repository repo");
    expect(out).toContain("Stage review");
    expect(out).toContain("change.criteriaChecked");
    expect(out).toMatch(/added: exit-gate change\.criteriaChecked/);
    expect(out).toMatch(/removed: exit-gate change\.merged/);
    expect(out).toMatch(/changed: exit-gate change\.findingsResolved .*onFail retry \(default\) -> onFail return implementation/);
    expect(out).toMatch(/changed: exit-gate change\.mergeable .*wait timeout 30m, poll 1m -> wait timeout 1h, poll 1m/);
    expect(out).toMatch(/changed: stage review concurrency 1 -> 2/);
    expect(out).toMatch(/removed: stage gone/);
    expect(out).not.toMatch(/changed: actions agent\.run/);
  });

  test("a repository present on one side only is listed as such", () => {
    const out = comparePlans([plan("only-left", [stage("a", [], [task("t", "x.y")])])], [plan("only-right", [stage("a", [], [task("t", "x.y")])])], { left: "A", right: "B" });
    expect(out).toContain("Repository only-left (only in A)");
    expect(out).toContain("Repository only-right (only in B)");
  });

  test("identical plans report no differences", () => {
    const same = () => plan("repo", [stage("a", [task("run", "agent.run", { kind: "act" })], [task("t", "x.y")])]);
    expect(comparePlans([same()], [same()], { left: "A", right: "B" })).toContain("no differences");
  });
});

describe("config compare", () => {
  test("compares the legacy fixture with the reference configuration, per repository and stage", async () => {
    const { directory, base } = await referenceConfigDirectory();
    bases.push(base);
    const lines: string[] = [];
    const code = await runCli(["config", "compare", LEGACY, directory], { out: (text) => lines.push(text), err: () => {}, interactive: false });
    expect(code).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("Repository service");
    // Side by side: legacy adapter tasks on the left, native tasks on the right.
    expect(out).toMatch(/legacy\.produce[^\n]*\|/);
    expect(out).toMatch(/\|\s+refine: agent\.run/);
    expect(out).toContain("Stage ci");
    expect(out).toContain("Stage review");
    expect(out).toMatch(/removed: stage ci/);
    expect(out).toMatch(/removed: actions legacy\.enterCheck/);
    expect(out).toMatch(/added: exit-gate item\.criteriaDefined/);
    expect(out).toMatch(/added: exit-gate change\.findingsResolved/);
    expect(out).toMatch(/added: exit-gate ci\.passed/);
    expect(out).toMatch(/added: stage cleanup|Stage cleanup/);
  });

  test("the v0.1 check-config --compare spelling still exits 0 and prints both sides", async () => {
    const { directory, base } = await referenceConfigDirectory();
    bases.push(base);
    const child = Bun.spawn(["bun", CLI, "check-config", "--config", LEGACY, "--compare", directory], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    // Both sides are deprecated configuration directories: one warning each, nothing else.
    expect(stderr.trim().split("\n").every((line) => line.startsWith("warning: loading a configuration directory is deprecated"))).toBe(true);
    expect(code).toBe(0);
    expect(stdout).toContain("Configuration is valid");
    expect(stdout).toContain("Repository service");
  });
});
