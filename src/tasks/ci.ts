// The `ci` task group. `ci.load` reads the head's runs, the definition and the durable gate
// facts (first sight of the head, started checks, reruns) into the `ci` snapshot. `ci.start` is
// the only task that changes CI state: it starts label-triggered runs, reruns a cancelled run
// once per (head, run name) and announces CI once per head. `ci.defined` and `ci.passed` are
// pure checks over the snapshot; the gate logic they share with the legacy `ci.await` source
// action lives in src/app/ci-gate.ts.

import { z } from "zod";

import { observeCi, observeCiError } from "../app/indicators";
import { boundLog, boundSnapshotLogs, classifyRuns, ciAnnouncement, describeCiFailure, readRunLog } from "../app/ci-gate";
import type { CiChange, CiProvider } from "../app/ci-provider";
import type { CodeHost } from "../codehost/types";
import type { ChangeContext, CiContext } from "./context";
import { defineGroup, fail, pass, pending, type TaskArgs, type TaskDefinition } from "./contract";
import type { TaskDeps } from "./deps";

type Deps = TaskDeps;
type Args<C = unknown, I = unknown> = TaskArgs<C, I, Deps>;

const NO_CHANGE = "No change request exists yet";
const SETTLE_SECONDS = 120;
const LOG_LINES = 60;
/**
 * Logs are read once at load time with this bound; `ci.passed` keeps their failing-test blocks and
 * the last `with.logLines` lines of their tail.
 */
const LOAD_LOG_LINES = 200;
/** All failed runs' logs together stay within this, so a red suite cannot outgrow the item context. */
const LOAD_LOG_BYTES = 24 * 1024;
const blocked = (message: string) => fail(message, { route: { stop: "blocked" } });

const startConfig = z.object({ retriggerMinutes: z.number().positive().default(10) });
const passedConfig = z.object({
  settleSeconds: z.number().positive().default(SETTLE_SECONDS),
  logLines: z.number().int().positive().max(LOAD_LOG_LINES).default(LOG_LINES),
});
const logsInput = z.object({ checkName: z.string().optional(), lines: z.number().optional() });

function providerOf(deps: Deps): CiProvider {
  if (!deps.ci) throw new Error(`no CI provider configured for ${deps.issueId}`);
  return deps.ci.provider();
}

const now = (deps: Deps): Date => (deps.clock ?? (() => new Date()))();
const short = (sha: string) => sha.slice(0, 7);

function ciChange(change: ChangeContext): CiChange {
  return { repository: "", changeId: String(change.ref.number ?? change.ref.id), url: change.url };
}

const load: TaskDefinition<unknown, unknown, Deps> = {
  name: "ci.load",
  kind: "load",
  description: "Loads the CI runs of the change's current head from the provider (ignoring `ci.ignoreChecks`), whether CI is defined for it, and the durable gate facts; null until a change request exists.",
  reads: ["change"],
  writes: ["ci"],
  invalidates: [],
  async run({ context, deps }: Args) {
    const change = context.change;
    if (!change) return pass(null);
    const provider = providerOf(deps);
    const target: CiChange = { ...ciChange(change), repository: deps.repository.address };
    const head = change.headSha;
    const observedAt = now(deps).toISOString();
    const marks = deps.store.executions();
    const firstSeenAt = marks.markCi(deps.issueId, head, "first-seen", "", observedAt).at;
    const ignored = new Set(deps.config.repositories[deps.repository.id]?.ci.ignoreChecks ?? []);
    const ignoreChecks = [...ignored];
    const indicator = { issueId: deps.issueId, headSha: head, changeUrl: change.url, ignoreChecks, now: now(deps), authoritative: true };
    let all: Awaited<ReturnType<CiProvider["list"]>>;
    try { all = await provider.list(target, head); }
    catch (error) { observeCiError(deps.store, { ...indicator, error }); throw error; }
    observeCi(deps.store, { ...indicator, runs: all });
    const listed = all.filter((run) => !ignored.has(run.name));
    const definition = await provider.definitions(target, head);
    const reruns = marks.ciMarks(deps.issueId, head, "rerun");
    const started = marks.ciMarks(deps.issueId, head, "started");
    // The provider may keep reporting the rerun run as cancelled for a while: that same id is still running.
    const rerunIds = new Set(marks.ciMarks(deps.issueId, head, "rerun-id"));
    const runs: CiContext["runs"] = [];
    for (const run of listed) {
      const state = run.state === "cancelled" && rerunIds.has(run.id) ? "running" : run.state;
      const wantsRerun = state === "cancelled" && run.canRerun && !reruns.includes(run.name);
      const log = (state === "failed" || state === "cancelled") && !wantsRerun
        ? await readRunLog(provider, target, run, LOAD_LOG_LINES) : null;
      runs.push({ id: run.id, name: run.name, state, url: run.url, rerunnable: run.canRerun, hasLog: run.hasLog, log });
    }
    const snapshot: CiContext = {
      headSha: head,
      defined: definition.defined,
      definitionProvable: definition.provable,
      definitionSummary: definition.summary,
      observedAt, firstSeenAt, reruns,
      awaitingStart: started.filter((name) => !runs.some((run) => run.name === name && run.state !== "skipped")),
      runs,
    };
    return pass(boundSnapshotLogs(snapshot, LOAD_LOG_BYTES));
  },
};

const start: TaskDefinition<z.output<typeof startConfig>, unknown, Deps> = {
  name: "ci.start",
  kind: "act",
  description: "Starts label-triggered CI runs for the change head, reruns a cancelled run once per head, announces CI once per head and, in advisory mode, starts the durable watch.",
  reads: ["repository", "change", "ci"],
  writes: [],
  invalidates: ["ci"],
  config: startConfig,
  async run({ context, deps, config, instance }: Args<z.output<typeof startConfig>>) {
    const change = context.change;
    const snapshot = context.ci;
    if (!change || !snapshot) return fail(NO_CHANGE);
    const provider = providerOf(deps);
    const target: CiChange = { ...ciChange(change), repository: deps.repository.address };
    const head = change.headSha;
    const at = now(deps);
    const marks = deps.store.executions();

    const waiting = await provider.start(target, head, config.retriggerMinutes * 60_000, at.getTime());
    for (const name of waiting) marks.markCi(deps.issueId, head, "started", name, at.toISOString());

    // Marked before the rerun so a crash in between loses one rerun rather than repeating it.
    const { rerun } = classifyRuns(snapshot.runs, (run) => run.rerunnable);
    for (const run of rerun) {
      if (marks.markCi(deps.issueId, head, "rerun", run.name, at.toISOString()).fresh) {
        marks.markCi(deps.issueId, head, "rerun-id", run.id, at.toISOString());
        await provider.rerun(target, run.id);
      }
    }

    const announced = snapshot.defined || snapshot.runs.length > 0 || waiting.length > 0;
    if (announced && marks.markCi(deps.issueId, head, "announced", "", at.toISOString()).fresh) {
      await deps.notify?.(ciAnnouncement(change.url, short(head), snapshot.runs, waiting), instance.stage);
    }
    // The runs a start created are visible now; the board need not wait for the next load.
    try {
      const ignoreChecks = deps.config.repositories[deps.repository.id]?.ci.ignoreChecks ?? [];
      observeCi(deps.store, { issueId: deps.issueId, headSha: head, changeUrl: change.url, ignoreChecks, now: now(deps), authoritative: true, runs: await provider.list(target, head) });
    } catch { /* the next load records the error */ }
    if (context.repository?.ciMode === "advisory") {
      await deps.ci?.watchAdvisory?.({ itemId: deps.issueId, headSha: head, stage: instance.stage, changeId: target.changeId, changeUrl: target.url });
    }
    return pass();
  },
};

const defined: TaskDefinition<unknown, unknown, Deps> = {
  name: "ci.defined",
  kind: "check",
  description: "Passes when CI is defined for the change head. Fails as blocked when no workflow applies or the provider cannot tell, so required CI never passes by having nothing to run.",
  reads: ["change", "ci"],
  writes: [],
  invalidates: [],
  run({ context }) {
    const snapshot = context.ci;
    if (!context.change || !snapshot) return fail(NO_CHANGE);
    if (!snapshot.definitionProvable) {
      return blocked(`Required CI could not be verified at ${short(snapshot.headSha)}: ${snapshot.definitionSummary}`);
    }
    if (!snapshot.defined) {
      return blocked(`Required CI has no applicable CI definition at ${short(snapshot.headSha)}: ${snapshot.definitionSummary}`);
    }
    return pass();
  },
};

const passed: TaskDefinition<z.output<typeof passedConfig>, unknown, Deps> = {
  name: "ci.passed",
  kind: "check",
  description: "Passes when every CI run of the change head passed. Pending during the settle window (default 120 s) and while runs are queued or running; fails with focused logs when a run failed.",
  reads: ["change", "ci"],
  writes: [],
  invalidates: [],
  config: passedConfig,
  checkpoint: { name: "ciPassed", scope: "task" },
  defaultWait: { timeoutMs: 3 * 3_600_000, pollMs: 60_000 },
  run({ context, config }) {
    const change = context.change;
    const snapshot = context.ci;
    if (!change || !snapshot) return fail(NO_CHANGE);
    const sha = short(snapshot.headSha);
    const reran = new Set(snapshot.reruns);
    const { running, failed, rerun } = classifyRuns(snapshot.runs, (run) => run.rerunnable && !reran.has(run.name));

    if (failed.length > 0) {
      const bounded = failed.map((run) => ({ ...run, log: run.log === null ? null : boundLog(run.log, { lines: config.logLines }) }));
      const report = describeCiFailure(change.url, sha, bounded);
      return fail(report.reason, { route: { retry: true }, details: { requiredFixes: report.requiredFixes, evidence: report.sections } });
    }
    if (rerun.length > 0) {
      const names = rerun.map((run) => run.name).join(", ");
      return fail(`CI run ${names} was cancelled at ${sha}; it will be rerun once.`, {
        route: { retry: true }, details: { requiredFixes: [], evidence: [] },
      });
    }
    const waitingOn = [...snapshot.awaitingStart.map((name) => `${name} to start`), ...running.map((run) => run.name)];
    const elapsedMs = Date.parse(snapshot.observedAt) - Date.parse(snapshot.firstSeenAt);
    if (waitingOn.length > 0 || elapsedMs < config.settleSeconds * 1_000) {
      return pending(`Waiting for CI at ${sha}: ${waitingOn.join(", ") || "checks to register"}.`);
    }
    return pass();
  },
};

async function logs(
  { deps, input }: Args<unknown, z.output<typeof logsInput>>,
) {
  const stored = deps.store.getCurrentPullRequest(deps.issueId);
  if (!stored) {
    return pass({ change: null, pullRequest: null, checks: [], note: "No pull request exists yet; CI runs after implementation opens it." });
  }
  const host: CodeHost | null | undefined = deps.codeHost;
  if (!host) throw new Error(`no code host configured for ${deps.issueId}`);
  const address = deps.repository.address;
  const delivery = await host.getChangeDelivery({ address, id: stored.id });
  const requested = input?.checkName ?? null;
  const lines = Math.min(Math.max(typeof input?.lines === "number" ? Math.floor(input.lines) : 200, 20), 1_000);
  const target: CiChange = { repository: address, changeId: String(delivery.change.number), url: delivery.change.url };
  const provider = providerOf(deps);
  const runs = await provider.list(target, delivery.change.headSha);
  const selected = runs.filter((run) => requested ? run.name === requested : run.state === "failed" || run.state === "cancelled");
  const checks = [];
  for (const run of selected.slice(0, 5)) checks.push({ ...run, log: await readRunLog(provider, target, run, lines) });
  return pass({
    change: delivery.change,
    pullRequest: delivery.pullRequest
      ? { number: delivery.pullRequest.number, url: delivery.pullRequest.url, headSha: delivery.pullRequest.headSha }
      : null,
    checks,
  });
}

const getLogs: TaskDefinition<unknown, z.output<typeof logsInput>, Deps> = {
  name: "ci.getLogs",
  kind: "tool",
  description: "Read the failing (or named) CI job logs for the change head, bounded to 20-1000 lines (default 200).",
  reads: [], writes: [], invalidates: [],
  input: logsInput,
  run: logs,
};

export const ciGroup = defineGroup("ci", [load, start, defined, passed, getLogs]);
