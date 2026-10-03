// A whole delivery world with fakes at the outside edges only: the shipped reference
// configuration (examples/config) with one repository, real git (a bare origin, a clone and the real
// WorkspaceManager), a fake code host, CI provider, GitHub items adapter and harness, and real
// `bun run` deploy/verify scripts. `drive` stands in for the reconciler between stages: it applies
// the labels the engine wrote and makes the next stage ready.

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";

import type { CiChange, CiProvider, CiRun } from "../../src/app/ci-provider";
import { ConveyorService } from "../../src/app/service";
import { CodeHostRegistry } from "../../src/codehost/registry";
import type { ChangeDelivery, ChangeRequest, CodeHost } from "../../src/codehost/types";
import { loadConfig } from "../../src/config/load";
import { ConveyorStore, type StoredIssue } from "../../src/db/store";
import { CriterionApprovals, criterionTextHash } from "../../src/engine/review-records";
import type { Harness, HarnessRunInput } from "../../src/harness/types";
import { EMPTY_USAGE, UNAVAILABLE_COST, type RunEnvelope } from "../../src/runner/result";
import { parseManagedSections, upsertManagedSection } from "../../src/source/github/managed-sections";
import { criteriaOf } from "../../src/tasks/item";

const EXAMPLES = path.resolve(import.meta.dir, "../../examples");
export const CRITERIA_BODY = "<!-- conveyor:acceptance-criteria:start -->\n- [ ] It works <!-- conveyor:criterion:works -->\n<!-- conveyor:acceptance-criteria:end -->\n";

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-c", "user.email=t@example.test", "-c", "user.name=Tests", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

export interface DeliveryWorld {
  root: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
  store: ConveyorStore;
  service: ConveyorService;
  host: FakeHost;
  ci: { runs: CiRun[] };
  /** Every agent invocation: the stage it ran for, in order. */
  agentRuns: string[];
  /** Every script invocation (`deploy` or `verify`), in order. */
  scriptRuns: string[];
  /** The label sets the engine wrote to the source, in order. */
  labelWrites: string[][];
  /** The stages the item was executed at, one entry per execute call. */
  executed: string[];
  /** Runs the item until it is done (or the step limit); returns the stages it advanced through. */
  drive(limit?: number): Promise<void>;
  close(): Promise<void>;
}

export interface FakeHost extends CodeHost {
  headSha: string;
  merges: Array<{ id: string; expectedHeadSha?: string }>;
  state: ChangeRequest["state"];
}

function fakeHost(): FakeHost {
  const id = "github:owner/conveyor#pr-5";
  let body = "";
  const host: FakeHost = {
    headSha: "",
    merges: [],
    state: "open",
    async pushBranch(input) {
      await git(input.workspace.path, "push", "--set-upstream", "origin", input.workspace.branch);
      host.headSha = await git(input.workspace.path, "rev-parse", "HEAD");
      return { pushed: true };
    },
    async ensureChange() { return change(); },
    async getChange() { return change(); },
    async mergeChange(input) {
      host.merges.push({ id: input.id, ...(input.expectedHeadSha ? { expectedHeadSha: input.expectedHeadSha } : {}) });
      host.state = "merged";
      return { merged: true, sha: "merge-sha" };
    },
    async setChangeChecklist(input) {
      body = upsertManagedSection(body, "acceptance-criteria", input.markdown, parseManagedSections(body).revision);
    },
    async getChangeDelivery(): Promise<ChangeDelivery> {
      const current = change();
      return {
        change: current, checks: [],
        pullRequest: {
          number: 5, url: current.url, state: current.state, merged: current.state === "merged", mergedAt: null,
          mergeCommitSha: current.state === "merged" ? "merge-sha" : null, draft: false, mergeState: "clean",
          headBranch: "", headSha: host.headSha, baseBranch: "main",
        },
      };
    },
    async createFinding() { return { url: "https://example.test/finding", projection: "comment:1" }; },
    async resolveFindingProjection() {},
    async resolveNativeFinding() {},
    async listReviewArtifacts() { return []; },
  };
  const change = (): ChangeRequest => ({
    id, number: 5, url: "https://github.com/owner/conveyor/pull/5", state: host.state, headSha: host.headSha,
    draft: false, mergeable: true, body,
  });
  return host;
}

const envelope = (summary: string): RunEnvelope => ({
  stageResult: { outcome: "success", status: "done", summary, reason: null, metrics: {} },
  sessionId: null, usage: { ...EMPTY_USAGE }, cost: { ...UNAVAILABLE_COST }, durationMs: 1, exitCode: 0, artifacts: [], stderr: "",
});

export async function deliveryWorld(): Promise<DeliveryWorld> {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-delivery-world-"));
  const directory = path.join(root, "config");
  await cp(path.join(EXAMPLES, "config"), directory, { recursive: true });

  // Real git: a bare origin and the repository clone the worktrees are cut from.
  const origin = path.join(root, "origin.git");
  const folder = path.join(root, "repos", "conveyor");
  await mkdir(folder, { recursive: true });
  await git(root, "init", "--bare", "-b", "main", origin);
  await git(folder, "init", "-b", "main");
  await git(folder, "remote", "add", "origin", origin);
  await writeFile(path.join(folder, "README.md"), "# repo\n");
  await git(folder, "add", "README.md");
  await git(folder, "commit", "-m", "initial");
  await git(folder, "push", "--set-upstream", "origin", "main");

  // Operator scripts are real `bun run` scripts; they record each run.
  const scriptLog = path.join(root, "scripts.log");
  const script = (name: string) => `import { appendFileSync } from "node:fs";\nawait Bun.stdin.text();\nappendFileSync(${JSON.stringify(scriptLog)}, "${name}\\n");\nconsole.log(JSON.stringify({ outcome: "success", summary: "${name} done" }));\n`;
  await writeFile(path.join(root, "deploy.ts"), script("deploy"));
  await writeFile(path.join(root, "verify.ts"), script("verify"));

  const example = parse(await readFile(path.join(EXAMPLES, "local/repositories.example.yaml"), "utf8")) as { repositories: Record<string, any> };
  const repository = { ...example.repositories.conveyor, address: "owner/conveyor", folder };
  repository.overrides = {
    stages: {
      deploy: { actions: { deployScript: { with: { script: path.join(root, "deploy.ts"), recovery: "replay-safe" } } } },
      verify: { actions: { verifyScript: { with: { script: path.join(root, "verify.ts"), recovery: "replay-safe" } } } },
    },
  };
  await writeFile(path.join(directory, "local.yaml"), stringify({
    settings: {
      database: path.join(root, "data/conveyor.sqlite"), logs: path.join(root, "data/logs"),
      workspaces: path.join(root, "data/worktrees"), artifacts: path.join(root, "data/artifacts"),
    },
    repositories: { conveyor: repository },
  }));
  const config = await loadConfig(directory);
  const store = await ConveyorStore.open(config.settings.database);
  store.upsertRepository({ id: "conveyor", configName: "conveyor", source: "github", address: "owner/conveyor", folder, configHash: config.hash });

  const host = fakeHost();
  const ci = { runs: [{ id: "1", name: "Tests", url: "https://ci.test/1", state: "passed", canRerun: false, hasLog: true }] as CiRun[] };
  const provider: CiProvider = {
    async start() { return []; },
    async list(_change: CiChange, _commit: string) { return ci.runs; },
    async rerun() {},
    async definitions() { return { defined: true, provable: true, summary: "Tests workflow" }; },
    async log() { return ""; },
  };
  const agentRuns: string[] = [];
  const labelWrites: string[][] = [];
  const github = {
    replaceConveyorLabels: async (_address: string, _number: number, labels: string[]) => { labelWrites.push([...labels]); },
    addComment: async () => 1,
  };

  const harness: Harness = {
    id: "fake",
    capabilities: { sessionResume: false },
    async run(input: HarnessRunInput): Promise<RunEnvelope> {
      const stage = /"stageId": "(\w+)"/.exec(input.prompt)?.[1] ?? "unknown";
      agentRuns.push(stage);
      if (stage === "refinement") {
        // darya: criteria and a system label, as item.setCriteria / item.setSystemLabels would write them.
        const issue = store.getIssue("issue")!;
        store.upsertIssue({ ...issue, body: CRITERIA_BODY, labels: [...issue.labels, "backend"], sourceUpdatedAt: new Date().toISOString() });
      } else if (stage === "implementation") {
        // kaveh: commits and pushes the branch.
        await writeFile(path.join(input.workspace, "feature.txt"), "feature\n");
        await git(input.workspace, "add", "feature.txt");
        await git(input.workspace, "commit", "-m", "Add the feature");
        const branch = await git(input.workspace, "rev-parse", "--abbrev-ref", "HEAD");
        await git(input.workspace, "push", "--set-upstream", "origin", branch);
      } else if (stage === "review") {
        // shirin: approves every criterion for the current head; no findings.
        const issue = store.getIssue("issue")!;
        const approvals = new CriterionApprovals(store.sqlite());
        for (const criterion of criteriaOf(issue.body)) {
          approvals.approve({
            issueId: issue.id, criterionId: criterion.id, reviewer: "shirin", headSha: host.headSha,
            checkedAt: new Date().toISOString(), textHash: criterionTextHash(criterion.text),
          });
        }
      }
      return envelope(`${stage} done`);
    },
  };

  const service = new ConveyorService(config, store, github as never, {
    harnesses: { codex: harness },
    codeHosts: new CodeHostRegistry().register("github", host),
  });
  Object.assign(service as object, {
    reconcileRepository: async () => {}, updateStatusComment: async () => {}, schedule: () => {},
    ciProvider: () => provider,
  });

  store.upsertIssue({
    id: "issue", repositoryId: "conveyor", sourceNumber: 1, sourceUrl: "https://github.com/owner/conveyor/issues/1",
    title: "Add the feature", body: "A feature request.", sourceState: "open", labels: ["conveyor", "conveyor:refinement"],
    sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  store.setIssueProjection("issue", { stage: "refinement", state: "active", warning: null });
  store.setQueueRank("issue", store.nextQueueRank());
  store.setStageState({ issueId: "issue", stageId: "refinement", status: "ready", feedbackCycle: 0, configHash: config.hash });

  const executed: string[] = [];
  const world: DeliveryWorld = {
    root, config, store, service, host, ci, agentRuns, labelWrites, executed,
    get scriptRuns() {
      try { return readFileSync(scriptLog, "utf8").split("\n").filter(Boolean); } catch { return []; }
    },
    async drive(limit = 40) {
      const controller = new AbortController();
      for (let step = 0; step < limit; step++) {
        const state = store.getStageState("issue")!;
        if (state.status === "done") return;
        if (state.status === "awaiting-source") {
          // The reconciler: read back the labels the engine wrote and make the next stage ready.
          const labels = labelWrites.at(-1)!;
          const issue = store.getIssue("issue")!;
          store.upsertIssue({ ...issue, labels, sourceUpdatedAt: new Date().toISOString() });
          if (labels.includes("conveyor:done")) {
            store.setIssueProjection("issue", { stage: state.stageId, state: "done", warning: null });
            store.setStageState({ issueId: "issue", stageId: state.stageId, status: "done", feedbackCycle: 0, configHash: config.hash });
          } else {
            store.setIssueProjection("issue", { stage: state.stageId, state: "active", warning: null });
            store.setStageState({ issueId: "issue", stageId: state.stageId, status: "ready", feedbackCycle: 0, configHash: config.hash });
          }
          continue;
        }
        // CI's settle window is wall-clock: age the first sighting instead of waiting for it.
        store.sqlite().query("UPDATE ci_marks SET created_at = ? WHERE kind = 'first-seen'").run("2000-01-01T00:00:00.000Z");
        executed.push(state.stageId);
        await (service as unknown as { execute(i: StoredIssue, s: AbortSignal): Promise<void> }).execute(store.getIssue("issue")!, controller.signal);
      }
      throw new Error(`the item did not finish in ${limit} steps; at ${JSON.stringify(store.getStageState("issue"))}`);
    },
    async close() { await service.close(); await rm(root, { recursive: true, force: true }); },
  };
  return world;
}
