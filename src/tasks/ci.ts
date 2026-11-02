// The `ci` task group. `ci.load` reads the head's runs, the definition and the durable gate
// facts (first sight of the head, started checks, reruns) into the `ci` snapshot. `ci.start` is
// the only task that changes CI state: it starts label-triggered runs, reruns a cancelled run
// once per (head, run name) and announces CI once per head. `ci.defined` and `ci.passed` are
// checks over the snapshot. `ci.passed` also records each completed required-CI outcome so it can
// stop a repeat deterministically; the gate logic it shares with the legacy `ci.await` source
// action lives in src/app/ci-gate.ts.

import { z } from "zod";

import { RepositoryPausedError } from "../core/repository-pause";
import { observeCi, observeCiError } from "../app/indicators";
import { boundLog, boundSnapshotLogs, ciFailureFingerprint, classifyRuns, ciAnnouncement, describeCiFailure, describeNeverStartedCi, readRunLog } from "../app/ci-gate";
import type { CiChange, CiProvider } from "../app/ci-provider";
import type { CodeHost } from "../codehost/types";
import { changeTopic, ciTopic } from "../events/topics";
import type { CiGateObservation } from "../engine/journal";
import type { ChangeContext, CiContext } from "./context";
import { defineGroup, fail, InfrastructureError, pass, pending, type TaskArgs, type TaskDefinition } from "./contract";
import type { TaskDeps } from "./deps";

type Deps = TaskDeps;
type Args<C = unknown, I = unknown> = TaskArgs<C, I, Deps>;

const NO_CHANGE = "No change request exists yet";
const SETTLE_SECONDS = 30;
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
      const log = (state === "failed" || state === "cancelled") && !wantsRerun && run.neverStarted === undefined
        ? await readRunLog(provider, target, run, LOAD_LOG_LINES) : null;
      runs.push({
        id: run.id,
        name: run.name,
        state,
        url: run.url,
        rerunnable: run.canRerun,
        hasLog: run.hasLog,
        ...(run.neverStarted === undefined ? {} : { neverStarted: run.neverStarted }),
        log,
      });
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

/**
 * Reruns each cancelled rerunnable run once per head and name.
 * Marked before the rerun so a crash in between loses one rerun rather than repeating it.
 * A repository pause is different: its fence runs before the provider write,
 * so release these provisional marks and preserve the rerun intent for resume.
 */
async function rerunCancelled(deps: Deps, target: CiChange, head: string, candidates: CiContext["runs"], at: Date): Promise<void> {
  const marks = deps.store.executions();
  const provider = providerOf(deps);
  const { rerun } = classifyRuns(candidates, () => true);
  for (const run of rerun) {
    if (marks.markCi(deps.issueId, head, "rerun", run.name, at.toISOString()).fresh) {
      marks.markCi(deps.issueId, head, "rerun-id", run.id, at.toISOString());
      try {
        await provider.rerun(target, run.id);
      } catch (error) {
        if (error instanceof RepositoryPausedError) {
          marks.unmarkCi(deps.issueId, head, "rerun", run.name);
          marks.unmarkCi(deps.issueId, head, "rerun-id", run.id);
        }
        throw error;
      }
    }
  }
}

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

    await rerunCancelled(deps, target, head, snapshot.runs.filter((run) => run.rerunnable), at);

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
  description: "Passes when every CI run of the change head passed. Pending during the settle window (default 30 s) and while runs are queued or running, until the head's CI finishes or the change gets a new head; reruns a cancelled run once per head without failing the gate; stops blocked when that rerun was used or impossible; fails with focused logs when a run failed. A second consecutive matching diagnosed failure stops for intervention.",
  reads: ["change", "ci", "repository", "run"],
  writes: [],
  invalidates: [],
  requestsRerun: true,
  config: passedConfig,
  checkpoint: { name: "ciPassed", scope: "task" },
  defaultWait: { timeoutMs: 3 * 3_600_000, pollMs: 60_000 },
  async run({ context, config, instance, issueId, journal, deps }) {
    const change = context.change;
    const snapshot = context.ci;
    if (!change || !snapshot) return fail(NO_CHANGE);
    const sha = short(snapshot.headSha);
    const reran = new Set(snapshot.reruns);
    const { running, failed, rerun } = classifyRuns(snapshot.runs, (run) => run.rerunnable && !reran.has(run.name));

    const ordinaryFailures = failed.filter((run) => run.neverStarted === undefined);
    // A cancelled run is not a failure of the work: with nothing else wrong it never routes back to the agent.
    const cancelledOnly = ordinaryFailures.length > 0 && ordinaryFailures.every((run) => run.state === "cancelled");
    if (ordinaryFailures.length > 0 && !cancelledOnly) {
      const bounded = boundedFailureRuns(ordinaryFailures, config.logLines);
      const report = describeCiFailure(change.url, sha, bounded);
      const fingerprint = ciFailureFingerprint(bounded);
      const observation = context.run && issueId && journal ? journal.recordCiGateObservation({
        issueId,
        stage: context.run.stage,
        expectedEpoch: context.run.stageEpoch,
        taskKey: instance.idempotencyKey,
        headSha: snapshot.headSha,
        outcome: "failed",
        fingerprint,
        checkNames: bounded.map((run) => run.name).sort(),
        evidence: report.sections,
        changeUrl: change.url,
      }) : null;
      if (fingerprint !== null && observation?.previous?.outcome === "failed" && observation.previous.fingerprint === fingerprint) {
        return fail(repeatedCiFailureReason(observation.previous, observation.observation), {
          route: { stop: "needs-intervention" },
          details: { requiredFixes: report.requiredFixes, evidence: [...observation.previous.evidence, ...observation.observation.evidence] },
        });
      }
      return fail(report.reason, { route: { retry: true }, details: { requiredFixes: report.requiredFixes, evidence: report.sections } });
    }
    if (cancelledOnly) return blocked(cancelledReason(ordinaryFailures, reran, sha));
    if (failed.length > 0) throw new InfrastructureError(describeNeverStartedCi(failed));
    // A cancelled run is not a failure of the work: its one rerun per head is requested here, so it
    // costs no feedback cycle and does not restart the agent, and the gate keeps waiting for it.
    if (rerun.length > 0) {
      await rerunCancelled(deps, { ...ciChange(change), repository: deps.repository.address }, snapshot.headSha, rerun, now(deps));
    }
    // A cancelled run whose one rerun was just requested: the gate waits for it.
    const waitingOn = [...snapshot.awaitingStart.map((name) => `${name} to start`), ...rerun.map((run) => `${run.name} (rerun requested)`), ...running.map((run) => run.name)];
    const elapsedMs = Date.parse(snapshot.observedAt) - Date.parse(snapshot.firstSeenAt);
    if (waitingOn.length > 0 || elapsedMs < config.settleSeconds * 1_000) {
      return pending(`Waiting for CI at ${sha}: ${waitingOn.join(", ") || "checks to register"}.`, ciWait(context.repository!.address, change, snapshot.headSha, waitingOn.length, config.settleSeconds * 1_000 - elapsedMs));
    }
    if (context.run && issueId && journal) {
      journal.recordCiGateObservation({
        issueId,
        stage: context.run.stage,
        expectedEpoch: context.run.stageEpoch,
        taskKey: instance.idempotencyKey,
        headSha: snapshot.headSha,
        outcome: "passed",
        fingerprint: null,
        checkNames: snapshot.runs.map((run) => run.name).sort(),
        evidence: [],
        changeUrl: change.url,
      });
    }
    return pass();
  },
};

/** Why an item stops on cancelled runs that will not be rerun: the rerun for this head is used up or the provider cannot rerun. */
function cancelledReason(runs: CiContext["runs"], reran: ReadonlySet<string>, sha: string): string {
  const lines = runs.map((run) => reran.has(run.name)
    ? `CI run ${run.name} was cancelled at ${sha}, and the one rerun for this head was already used.`
    : `CI run ${run.name} was cancelled at ${sha}, and the provider could not rerun it.`);
  return [...lines, "Rerun the check from the pull request's checks page, or push a new head, then retry the item."].join(" ");
}

function boundedFailureRuns(failed: CiContext["runs"], lines: number) {
  return failed.map((run) => {
    if (run.log === null) return run;
    const log = boundLog(run.log, { lines });
    return { ...run, log: log === run.log ? log : `${log}\n[Excerpt truncated by Conveyor.]` };
  });
}

function repeatedCiFailureReason(first: CiGateObservation, second: CiGateObservation): string {
  const evidence = (label: string, observation: CiGateObservation) => [
    `${label} failure: ${observation.changeUrl} at ${short(observation.headSha)}.`,
    `Failed checks: ${observation.checkNames.join(", ") || "unknown"}.`,
    ...observation.evidence,
  ].join("\n\n");
  return [
    "The same required CI failure repeated. Another automatic retry will not fix it.",
    evidence("First", first),
    evidence("Second", second),
  ].join("\n\n");
}

/**
 * What a CI wait waits for: the head's CI finishing, or the change moving to another head. While
 * nothing runs, only the settle window remains, so it looks again when that ends.
 */
function ciWait(address: string, change: ChangeContext, head: string, unfinished: number, settleRemainingMs: number) {
  const topics = [ciTopic(address, head), ...(change.ref.number !== null ? [changeTopic(address, change.ref.number)] : [])];
  return {
    waitFor: { topics, kind: "ci" as const },
    ...(unfinished === 0 && settleRemainingMs > 0 ? { after: Math.ceil(settleRemainingMs) } : {}),
  };
}

const settled: TaskDefinition<z.output<typeof passedConfig>, unknown, Deps> = {
  name: "ci.settled",
  kind: "act",
  description: "Waits for the current change head's CI checks to register and settle before a later action runs. A settled failure still passes so the reviewer can judge it.",
  // Settlement only needs each check's state.  Do not implicitly load the full CI snapshot here:
  // its diagnostics include failed-job logs, which would otherwise be downloaded on every poll.
  reads: ["change"],
  writes: [],
  invalidates: [],
  config: passedConfig,
  defaultWait: { timeoutMs: 3 * 3_600_000, pollMs: 60_000 },
  async run({ context, deps, config }: Args<z.output<typeof passedConfig>>) {
    const change = context.change;
    if (!change) return fail(NO_CHANGE);
    const provider = providerOf(deps);
    const target: CiChange = { ...ciChange(change), repository: deps.repository.address };
    const head = change.headSha;
    const observedAt = now(deps).toISOString();
    const marks = deps.store.executions();
    const firstSeenAt = marks.markCi(deps.issueId, head, "first-seen", "", observedAt).at;
    const ignored = new Set(deps.config.repositories[deps.repository.id]?.ci.ignoreChecks ?? []);
    const indicator = { issueId: deps.issueId, headSha: head, changeUrl: change.url, ignoreChecks: [...ignored], now: now(deps), authoritative: true };
    let all: Awaited<ReturnType<CiProvider["list"]>>;
    try { all = await provider.list(target, head); }
    catch (error) { observeCiError(deps.store, { ...indicator, error }); throw error; }
    observeCi(deps.store, { ...indicator, runs: all });

    const rerunIds = new Set(marks.ciMarks(deps.issueId, head, "rerun-id"));
    const runs = all
      .filter((run) => !ignored.has(run.name))
      .map((run) => ({ name: run.name, state: run.state === "cancelled" && rerunIds.has(run.id) ? "running" : run.state }));
    const started = marks.ciMarks(deps.issueId, head, "started");
    const awaitingStart = started.filter((name) => !runs.some((run) => run.name === name && run.state !== "skipped"));
    const { running } = classifyRuns(runs, () => false);
    const waitingOn = [...awaitingStart.map((name) => `${name} to start`), ...running.map((run) => run.name)];
    const elapsedMs = Date.parse(observedAt) - Date.parse(firstSeenAt);
    if (waitingOn.length > 0 || elapsedMs < config.settleSeconds * 1_000) {
      return pending(`Waiting for CI at ${short(head)}: ${waitingOn.join(", ") || "checks to register"}.`, ciWait(deps.repository.address, change, head, waitingOn.length, config.settleSeconds * 1_000 - elapsedMs));
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

export const ciGroup = defineGroup("ci", [load, start, defined, passed, settled, getLogs]);
