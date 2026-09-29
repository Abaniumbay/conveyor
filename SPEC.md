# Conveyor v0.1 — Product and Engineering Specification

Status: Draft for review  
Runtime: Bun + TypeScript  
Primary source adapter: GitHub  
Persistence: SQLite + filesystem logs

## 1. Purpose

Conveyor is a lightweight, always-on handoff engine for delivering software from issues.

The user is the product owner and tester. They create and refine work through issues, answer occasional questions, and may steer a run. After refinement, Conveyor should normally take an issue through implementation, review, merge, deployment, and verification without human involvement.

Conveyor is not a second issue tracker and not a general workflow platform. The configured issue source remains authoritative; GitHub is the only source implemented in v0.1. The web UI is a reliable operational projection that explains what is running, what is waiting, why something is blocked, what it cost, and what needs human attention.

## 2. Non-negotiable rules

1. Source issue state, content, labels, hierarchy, dependencies, changes, and checks are authoritative. In v0.1, that source is GitHub.
2. Conveyor never changes an existing issue's open/closed state. It may create refined child issues, edit managed body sections, add comments, and manage labels.
3. A Conveyor-created PR may close an issue through GitHub's normal closing-reference behavior.
4. An issue that completed the configured pipeline receives `conveyor:done`. If it remains open, it also receives `conveyor:closable`.
5. A parent issue is never closed by Conveyor. When all descendants are satisfied, it becomes done and, if open, closable.
6. The engine contains no hardcoded delivery stages. Stages, checks, agents, scripts, retry limits, labels, and status presentation come from configuration.
7. Source mutations made by agents go through Conveyor's MCP tools. Agents do not call the issue source directly.
8. No container-per-issue isolation is used. Code work happens only in Git worktrees; the repository's primary checkout is never modified.
9. Completed stage attempts are durable checkpoints. A process failure never causes one to rerun; only an explicit configured verifier-feedback transition may reopen a producer stage.
10. Cost is observed and reported, never used to enforce a budget or stop work.
11. Review agents do not change code. They return approval or actionable feedback to the implementation agent.
12. Requirement changes do not interrupt an active run. A later review/check evaluates the latest issue state and sends outdated work back for correction.

## 3. Product boundary

### Included in v0.1

- One Bun service containing the web server, webhook receiver, reconciler, scheduler, process supervisor, MCP server, and SQLite access.
- GitHub issue source adapter.
- Codex CLI agent runner.
- Generic JSON-returning process runner; bundled examples and checks use TypeScript.
- Configurable sequential pipelines with enter and exit verification.
- Durable retries, waiting, questions, costs, logs, worktrees, hierarchy, and dependencies.
- Minimal authenticated web UI with live status, backlog ordering, questions, steering, history, and costs.
- Automatic PR creation and squash merge when the configured pipeline permits it.
- Repository-specific script or agent stages for testing, deployment, and verification.

### Explicitly excluded from v0.1

- A general DAG workflow engine.
- Multiple web users, roles, password management, or external identity providers.
- Container or VM isolation.
- A built-in code editor or full GitHub replacement.
- Claude and OpenCode runner implementations. Their runner interface is defined, but Codex is the only built-in agent runner.
- GitLab or other issue-source implementations. Their adapter interface is defined, but GitHub is the only built-in source.
- Config hot reload.
- Automatic rollback or repair after a change has merged.
- Automatic closing of issues.
- Cost limits, approval budgets, or cost-aware scheduling.

## 4. Architecture

Conveyor runs as one systemd-managed Bun process. It uses:

- `Bun.serve` for HTTP, webhooks, the UI, and server-sent events.
- `bun:sqlite` in WAL mode for durable operational state.
- Bun subprocesses for scripts and CLI harnesses.
- Server-rendered HTML with small, dependency-free browser JavaScript. No SPA framework is required.
- A per-run, context-scoped MCP connection for agents.
- Plain files for full stdout/stderr logs and retained artifacts.

SQLite is an operational journal and projection, not the issue source of truth. It stores scheduling order, leases, attempts, events, questions, costs, source cursors, and cached source data. Reconciliation must be capable of rebuilding the source projection.

Unauthenticated liveness and authenticated readiness/diagnostic endpoints report process, database, scheduler, disk, webhook, and last-reconciliation health without exposing issue content or secrets. The UI shows degraded repositories without stopping healthy repositories.

## 5. Plugin contracts

The core orchestrator knows only these plugin roles:

### Source adapter

Provides repositories, issues, labels, comments, managed body sections, parent/child relationships, dependencies, pull requests, checks, deployment observations, webhooks, and reconciliation.

The GitHub adapter uses the configured `gh` authentication for v0.1. On repository onboarding it creates missing configured Conveyor/project labels, validates the existing checkout, and installs or validates the repository webhook. Missing permissions put the repository into a visible misconfigured state and prevent scheduling; webhook failure may fall back to reconciliation when API read access still works.

### Runner

Starts, observes, interrupts, and reports a unit of execution. V0.1 supplies:

- `codex`: an agent runner using Codex CLI in non-interactive mode.
- `json-process`: a generic command runner whose stdout is one validated JSON result.

One executable stage uses exactly one producer: an agent, a JSON process, or an idempotent source-adapter action. Harness-native subagents are allowed within an agent producer, but they remain part of the lead run and do not become independent Conveyor runs.

### Source action

A source adapter may expose schema-validated, idempotent actions such as ensuring a pull request, awaiting source checks/deployments, or squash-merging a PR. Pipelines reference these capabilities by name. The engine does not infer them from stage names. An action may yield a durable external-wait condition keyed to a webhook/reconciliation event; this releases permits and later resumes the same action without completing the stage. An action failure is retried as infrastructure work when transient and becomes the configured blocking state when permanent.

### Check

A check is required at both entry and exit of every stage and contains:

1. An optional deterministic TypeScript evidence script.
2. A configured verifier agent that evaluates the issue, workspace, evidence, and latest acceptance criteria.

The verifier is distinct from the stage's producer. It returns a clear decision, supporting evidence, and required fixes.

### Stage

A stage is configuration tying together exactly one producer, required enter and exit checks, concurrency, labels, retry policy, lifecycle actions, and result handling. A producer can be an agent, a JSON process, or a source action. The engine assigns no semantics to a stage name.

Configured `afterSuccess` actions execute after exit verification but before the stage checkpoint and label transition are committed. They are intended for safe, idempotent operations such as ensuring a PR. They do not create hidden stages, and their failure cannot advance the pipeline.

## 6. Configuration

Configuration lives outside managed repositories and may be split hierarchically:

```text
config/
  conveyor.yml
  repositories.yml
  pipelines.yml
  runners.yml
  agents/
    jack.yml
    implementer.yml
    reviewer.yml
    checker.yml
  instructions/
    jack.md
    implementer.md
    reviewer.md
    checker.md
  checks/
    refinement.enter.ts
    refinement.exit.ts
    implementation.exit.ts
  stages/
    deploy.ts
    verify.ts
    cleanup.ts
```

All files are loaded, merged, and schema-validated at startup. Relative paths resolve from the file that declares them. Top-level maps merge by unique ID; defining the same runner, agent, check, pipeline, or repository twice is an error rather than a silent override. An invalid configuration prevents the service from starting and reports exact file paths and fields. Restarting the service is required after a configuration change.

The validated configuration receives a content hash stored with every run. After restart, unfinished work uses the newly validated definition for its existing stage ID. A removed/renamed current stage or incompatible label mapping blocks that issue with a configuration-drift warning instead of guessing a migration.

Illustrative configuration—not a built-in pipeline:

```yaml
settings:
  runners: 10
  database: ./data/conveyor.sqlite
  logs: ./data/logs
  workspaces: ./data/worktrees
  artifacts: ./data/artifacts
  reconcileInterval: 5m
  feedbackCycles: 2
  labelPrefix: conveyor
  interruptGrace: 10s
  retries:
    infrastructureAttempts: 5
    usageLimitAttempts: unlimited
    minBackoff: 30s
    maxBackoff: 30m

web:
  listen: 127.0.0.1:4300
  publicUrl: https://conveyor.example.com

sources:
  github:
    type: github
    webhookPath: /hooks/github
    autoConfigureWebhook: true
    allowedHumanLogins: [your-github-login]

runners:
  codex:
    type: codex
    command: codex
    sandbox: workspace-write
    automaticApprovals: true
  process:
    type: json-process

agents:
  jack:
    runner: codex
    model: configured-model-name
    effort: high
    instructions: ./instructions/jack.md
  implementer:
    runner: codex
    model: configured-model-name
    effort: medium
    instructions: ./instructions/implementer.md
  reviewer:
    runner: codex
    model: configured-model-name
    effort: high
    instructions: ./instructions/reviewer.md
    workspaceAccess: read-only
  checker:
    runner: codex
    model: configured-model-name
    effort: high
    instructions: ./instructions/checker.md
    workspaceAccess: read-only

checks:
  generic-enter:
    verifier: checker
  generic-exit:
    verifier: checker
  refinement-enter:
    script: ./checks/refinement.enter.ts
    verifier: reviewer
  refinement-exit:
    script: ./checks/refinement.exit.ts
    verifier: reviewer
  implementation-exit:
    script: ./checks/implementation.exit.ts
    verifier: checker

labels:
  enrollment: conveyor
  stageTemplate: "conveyor:{stage}"
  states:
    done: conveyor:done
    rejected: conveyor:reject
    blocked: conveyor:blocked
    error: conveyor:error
    needs-input: conveyor:needs-input
    needs-intervention: conveyor:needs-intervention
    waiting: conveyor:waiting
  metadata:
    closable: conveyor:closable
    orderTemplate: "conveyor:order:{number}"

pipelines:
  default:
    successStatuses: [done, skipped]
    failureStatuses: [blocked, rejected, error, changes-requested, needs-intervention]
    stages:
      - id: refinement
        run:
          agent: jack
        concurrency: 5
        childrenStartAt: next
        enterCheck: refinement-enter
        exitCheck: refinement-exit
        feedbackCycles: 2
      - id: implementation
        run:
          agent: implementer
        concurrency: 2
        enterCheck: generic-enter
        exitCheck: implementation-exit
        afterSuccess:
          - sourceAction: pullRequest.ensure
            with:
              closingReference: true
      - id: review
        run:
          agent: reviewer
        concurrency: 2
        enterCheck: generic-enter
        exitCheck: generic-exit
        failurePolicies:
          changes-requested:
            action: returnToPrevious
        feedbackCycles: 2
      - id: merge
        run:
          sourceAction: pullRequest.squashMerge
        concurrency: 2
        enterCheck: generic-enter
        exitCheck: generic-exit
      - id: deploy
        run:
          runner: process
          script: ./stages/deploy.ts
        concurrency: 2
        enterCheck: generic-enter
        exitCheck: generic-exit
        feedbackCycles: 0
        failureState: needs-intervention
      - id: verify
        run:
          runner: process
          script: ./stages/verify.ts
        concurrency: 2
        enterCheck: generic-enter
        exitCheck: generic-exit
        feedbackCycles: 0
        failureState: needs-intervention
      - id: cleanup
        run:
          runner: process
          script: ./stages/cleanup.ts
        concurrency: 10
        enterCheck: generic-enter
        exitCheck: generic-exit
        feedbackCycles: 0
        failureState: needs-intervention

repositories:
  example:
    source: github
    address: owner/repository
    folder: /srv/projects/example
    baseBranch: main
    pipeline: default
    concurrency: 1
    systemLabels: [backend, web, mobile, infrastructure]
```

Secrets are environment variables and never appear in YAML:

- `CONVEYOR_USERNAME`
- `CONVEYOR_PASSWORD_HASH`
- `CONVEYOR_SESSION_SECRET`
- `CONVEYOR_GITHUB_WEBHOOK_SECRET`
- Any runner/provider credentials not already supplied by the CLI environment

## 7. Issue enrollment and label semantics

The configurable default prefix is `conveyor`.

Conveyor labels have four roles:

- Enrollment: the base `conveyor` label.
- Progress: exactly one configured stage label, normally `conveyor:<stage-id>`.
- State: at most one configured waiting, blocking, or terminal label.
- Metadata: non-exclusive flags such as closable and sibling order.

Eligibility is resolved in this order:

1. No label matching `conveyor` or `conveyor:*`: fully offboarded and absent from the active UI.
2. At least one matching label but no base `conveyor`: paused/excluded, visible in the UI, and never scheduled regardless of its remembered stage/state.
3. Manually closed before merge: stopped immediately and no further delivery work is scheduled.
4. Base label plus a waiting, blocking, or terminal state: visible but not eligible until the corresponding question, retry, or explicit restart transition resolves it. Done and rejected never restart automatically.
5. Base label plus an open issue and no stopping state: active. A newly enrolled issue with no stage label enters the first configured stage; otherwise its one valid stage label selects the stage.

The expected closure caused by merging the issue's own Conveyor-managed PR is the sole exception to step 3: explicitly configured post-merge stages remain eligible until a terminal result.

Pausing interrupts the current process, releases its concurrency permit, and preserves its worktree. Restoring the base label starts a fresh agent process at the same incomplete stage using the existing worktree and current source state. Previous chat transcript is not injected.

Full offboarding interrupts any local runner and releases its permit, but causes no source calls or mutations for that issue and no cleanup action. After processing the event that removed the final Conveyor label, it is excluded from reconciliation; repository-level webhooks are still accepted so a new matching label can enroll it again. Audit records and local state are retained. If the issue is enrolled again later, Conveyor removes its stale worktree, creates a clean worktree from the configured base branch, and starts from the first configured stage.

Only one configured stage label and one exclusive state label may be active. The default stage convention is `conveyor:<stage-id>`, but every mapping is configurable. Multiple stage labels, incompatible state labels, an unknown stage label, or a closed issue with an active pre-merge label produces a visible inconsistency warning and prevents scheduling until reconciled.

A valid external change to a control label is authoritative. Changing the selected stage or applying a stopping state interrupts the active attempt and moves the projection to that source-selected state. Edits to requirements, acceptance criteria, dependencies, or ordinary system labels update the projection but do not interrupt the active attempt; later verification uses the latest values.

Conveyor records the successful checkpoint and a pending transition locally, replaces only the labels it owns while preserving unrelated labels, and confirms the source update before making the next stage schedulable. A source update failure retains the durable checkpoint but leaves the issue at the prior source stage with a visible pending-mutation/error state; recovery retries the idempotent mutation rather than rerunning the producer. The issue never runs ahead of its source labels.

Terminal/default labels include:

- `conveyor:done`
- `conveyor:closable`
- `conveyor:reject`
- `conveyor:blocked`
- `conveyor:error`
- `conveyor:needs-input`
- `conveyor:needs-intervention`
- `conveyor:waiting` for an automatic infrastructure/usage retry
- `conveyor:order:<number>` for siblings

These names are defaults, not core constants; the configuration maps logical presentation states to source labels.

## 8. Lifecycle and verification

For each stage, the engine performs:

```text
enter evidence -> enter verifier -> producer -> exit evidence -> exit verifier
```

- Enter-check failure returns feedback to the preceding stage's producer.
- If the first stage's enter check fails, there is no preceding producer; it becomes blocked or needs input according to the check result.
- Exit-check failure returns feedback to the current stage's producer.
- A producer failure normally stops at its configured state. A status-specific `returnToPrevious` policy may instead append its feedback to the preceding producer, which is how a read-only review stage requests code changes.
- The corrected producer reruns in a fresh agent process against the preserved worktree.
- The default maximum is two producer/verifier feedback cycles, configurable per stage.
- Exhaustion produces a configured failure status, normally blocked, with the full reason and required user action.
- Usage limits and infrastructure retries do not consume feedback cycles.

Every producer and verifier evaluates the latest issue content. If requirements change during a producer run, that run continues; the next verifier catches any mismatch.

When an enter check reopens the preceding stage, its earlier successful attempts remain immutable history. Conveyor appends a correction attempt, reruns that stage's exit check, and then reruns the failed enter check. No downstream stage is considered complete until this boundary passes.

Evidence scripts return structured facts and do not make the semantic decision. A verifier returns:

```json
{
  "version": 1,
  "decision": "fail",
  "status": "blocked",
  "reason": "The empty-state behavior is not covered.",
  "evidence": ["Test output and file references"],
  "requiredFixes": ["Implement and test the empty state."],
  "criteria": [
    { "id": "AC-1", "passed": true, "evidence": "test-name" },
    { "id": "AC-2", "passed": false, "evidence": "missing" }
  ]
}
```

`decision` is `pass` or `fail`; `status` is validated against the check/stage configuration. A failure requires a reason and at least one required fix unless its status is rejected or it opened a structured human question. Criterion results let the engine update its managed checklist and UI without allowing the reviewer to edit code.

Stage results have only two core outcomes. Status names remain configuration-defined:

```json
{
  "version": 1,
  "outcome": "success",
  "status": "done",
  "summary": "Implemented and validated the requested behavior.",
  "reason": null,
  "metrics": {}
}
```

`success` advances to the next stage when `status` is listed in the stage's effective `successStatuses`, inherited from its pipeline unless overridden. `failure` stops or invokes the status-specific configured feedback policy. A `returnToPrevious` correction is the only backward pipeline transition in v0.1; arbitrary jumps and branching are not supported. Status strings have no engine meaning beyond their configured policy and label mapping. For example, already-done normally maps to successful `skipped`, infeasible maps to failed `rejected`, code-review changes map to failed `changes-requested` with `returnToPrevious`, and a question creates run-level waiting state rather than a fabricated stage result.

Every runner is normalized into this durable run envelope. The engine owns `durationMs` and `exitCode`; runners populate fields they can observe:

```json
{
  "version": 1,
  "stageResult": {
    "outcome": "success",
    "status": "done",
    "summary": "Completed the configured work.",
    "reason": null,
    "metrics": {}
  },
  "sessionId": null,
  "usage": {
    "inputTokens": 0,
    "outputTokens": 0,
    "cachedTokens": 0
  },
  "cost": {
    "amount": 0,
    "currency": "USD",
    "source": "unavailable"
  },
  "durationMs": 12345,
  "exitCode": 0,
  "artifacts": []
}
```

JSON-process scripts receive a versioned JSON object on stdin containing repository, issue, stage, attempt, workspace, configuration, feedback, and scoped artifact paths. They must emit exactly one schema-valid producer result on stdout; the process runner wraps it in the durable envelope. Scripts may also report usage and monetary cost when known. Human-readable logs go to stderr. Invalid or extra stdout is a runner failure.

After exit verification passes, configured `afterSuccess` actions run idempotently. Only after they succeed does Conveyor record the completed checkpoint and pending source transition; the next stage becomes schedulable only after the source label change is confirmed. Transient action failures retry without consuming a feedback cycle; permanent failures block with the adapter's exact reason.

## 9. Refinement, acceptance criteria, and hierarchy

Refinement must produce:

- A clear scope and structured acceptance-criteria checklist.
- Configured project/system labels such as backend, web, mobile, or infrastructure.
- A decision such as ready, already done, infeasible, rejected, or needing input.
- Dependencies and sibling order.
- Parent/child decomposition when required.
- A concise rationale visible in the issue.

Acceptance criteria live in a managed issue-body section while all content outside that section remains untouched:

```markdown
<!-- conveyor:acceptance-criteria:start -->
## Acceptance Criteria

- [ ] First observable behavior <!-- conveyor:criterion:AC-1 -->
- [ ] Second observable behavior <!-- conveyor:criterion:AC-2 -->
<!-- conveyor:acceptance-criteria:end -->
```

Stable hidden IDs keep verifier evidence connected when criteria are reordered. Content outside the managed markers is never changed. Content inside the markers remains source-authoritative: writes use optimistic revision checks so a concurrent human edit is re-read and verified rather than overwritten.

The reviewer checks every criterion against the current issue and implementation. Conveyor never marks criteria complete merely because a producer claims success; the configured verifier supplies the evidence-based decision and the engine applies validated checkbox updates.

When refinement decomposes an issue:

- It creates native GitHub subissues.
- Each child is fully refined, labeled, and starts at the stage selected by the producer stage's `childrenStartAt` configuration, normally the following stage; preceding results are recorded as skipped.
- The original becomes a roll-up parent and performs no implementation work itself.
- The parent's temporary refinement worktree is removed after decomposition succeeds; each child receives a clean worktree and unique branch from the then-current configured base branch.
- Children are independently releasable, each with its own worktree, branch, and PR.
- Nested subissues are supported.
- Sibling order is stored in `conveyor:order:<number>` labels and is not draggable in the global backlog.
- A parent becomes done when all descendants are closed or have `conveyor:done`.

GitHub-native issue dependencies are used when supported and mirrored in a managed issue section for human visibility. Unsupported cross-repository relationships fail refinement verification rather than being silently stored only in SQLite. A dependency is satisfied when its issue is closed or labeled `conveyor:done`. A closed dependency without the done label is accepted but shown as an inconsistency.

Parent roll-up mutations run only while the parent retains its active base label. A paused or fully offboarded parent can be shown as logically complete in the UI, but Conveyor does not label it done/closable until it is active again.

## 10. Scheduling and concurrency

The UI has one global backlog spanning configured repositories.

- Every onboarded top-level issue receives a global rank, initially by creation time. The rank is preserved across stages, pauses, and restarts; dragging is enabled only while the item is in backlog.
- Manual global ranks are stored in SQLite because queue priority is operational UI state, not issue truth.
- Only top-level items are draggable. Children remain nested under their parent.
- When a top-level issue is decomposed, its roll-up parent retains the same global rank and its children are scanned beneath it in configured sibling order.
- The scheduler scans the flattened visible hierarchy from top to bottom and starts the first eligible items.
- A blocked/dependent item does not prevent later eligible items from starting.

A runnable stage phase must acquire its applicable permits:

1. The stage's `concurrency`.
2. The repository's `concurrency`.
3. Global `settings.runners` when starting an agent, script, or verifier OS process.

The global permit counts live OS-level runner processes; an in-process source action does not consume it. Stage and repository permits count issues currently executing in that scope, including source actions; a producer and verifier for the same issue never overlap. Questions, pauses, automatic backoff, blocked states, and completed attempts hold no permits. Harness-native subagents remain inside the lead runner's single permit.

## 11. Workspace and Git behavior

Each configured repository folder must be an existing accessible Git checkout; v0.1 never clones repositories. On fresh enrollment, an issue receives one clean worktree and branch created from the latest fetched repository base branch, defaulting to `main`. If refinement converts it into a roll-up parent, that temporary worktree is removed and new child worktrees are created. A resumed paused issue reuses its worktree; a fully offboarded and later re-enrolled issue receives a new enrollment generation.

- Conveyor may fetch, create worktrees/branches, commit, and push through runner/MCP operations scoped to the issue.
- It never changes files or branches in the configured primary checkout.
- Branch naming defaults to `conveyor/<issue-number>-r<enrollment>-<slug>`, preventing a stale remote branch from a prior enrollment from being reused accidentally.
- The implementation agent is responsible for keeping its branch current with the base branch before reporting success.
- Review checks mergeability. Conflicts or an outdated branch are returned to implementation as feedback.
- A configured, idempotent `pullRequest.ensure` action opens or refreshes the PR after the chosen stage; the example attaches it to implementation success.
- A configured `pullRequest.squashMerge` source-action stage performs the merge only after prior configured review/check stages approve.
- Formal GitHub PR approval is not submitted by the reviewer; its approval is an internal audited result and issue/PR status update.
- Branch-protection refusal or any merge failure that cannot be repaired within the pre-merge feedback loop becomes blocked or needs intervention.

The PR includes the configured GitHub closing reference. There is one implementation PR per issue enrollment in the normal path. Agents receive no GitHub API token; authenticated fetch/push/PR/merge operations are performed by the engine or scoped MCP/source actions. The implementation agent may make local commits and request safe fetch/push operations through MCP.

Reviewers run with read-only code permissions. Tests or builds that need to write caches/output run in deterministic evidence scripts or configured temporary paths; the reviewer consumes their results and cannot modify source files.

Manual closure normally stops an issue. The narrow exception is an issue closed by the successful merge of its own Conveyor-managed PR: configured post-merge deploy and verification stages continue. This correlation is recorded at merge time; a coincidental/manual closure is never assumed to be a Conveyor merge.

The example config gives post-merge stages zero semantic feedback cycles and maps failure to `needs-intervention`. Therefore, if deployment or verification fails after merge, Conveyor does not roll back, modify code, or create a repair PR; it records diagnostics and asks the user to intervene. A clearly classified transient runner/infrastructure failure may still use the separate infrastructure retry policy before the stage is declared failed.

Normal successful terminal processing runs the configured cleanup stage to remove the worktree, transient files, and the local issue branch when it is safe to delete. The cleanup process runs from a service-owned run directory, never from the directory it deletes; its exit verifier receives deterministic cleanup evidence and supports an absent worktree. Local cleanup never deletes a remote branch unless an explicit source action is configured. SQLite history, logs, costs, and declared artifacts remain. Blocked, rejected, needs-intervention, paused, and fully offboarded issues retain their worktree for diagnosis or resumption; stale state is replaced if they are later freshly enrolled.

## 12. Questions and human steering

Any agent may ask a structured question through MCP. Refinement questions are expected; questions in later stages should be exceptional.

A question contains an ID, prompt, reason, zero or more options with stable IDs, minimum/maximum selections, whether free text is allowed, and the requesting stage/run. Only one unanswered question may exist per issue. Conveyor then:

1. Adds the configured needs-input label.
2. Posts the question to the issue conversation.
3. Shows option controls and free text in the web UI.
4. Stops the process and releases its permits.
5. Mirrors the web answer back to the issue conversation.
6. Clears needs-input and starts a fresh attempt at the same stage.

The new attempt receives the current issue, the explicit question/answer, existing workspace, stage feedback, and durable artifacts—but not the previous private chat transcript.

The web UI is the primary answer path. The question comment contains a hidden question ID; a subsequent non-bot comment from a configured allowed GitHub login is also accepted as the answer while that question is open. UI answers use an idempotent source mutation, so the mirrored bot comment cannot be consumed as a second answer.

The UI provides pause/resume and retry controls. Pause removes only the base label; resume restores it; retry clears a configured nonterminal blocking/error state while preserving the current stage. Done and rejected cannot be restarted accidentally from the UI—the user must deliberately change the source labels. Source-label semantics remain authoritative: controls perform the corresponding label action through the source adapter rather than creating a second state system.

An explicit **Steer** action is different from an ordinary issue edit: it mirrors the instruction into the issue conversation, interrupts the current process, and starts a fresh attempt at the same stage with the preserved worktree and steering instruction. Steering is user-initiated infrastructure control and does not consume a verifier feedback cycle.

## 13. Agent MCP surface

Every agent receives a scoped MCP server for exactly one repository, issue, stage, and run, plus its worktree when that stage has one. Cleanup and source-only stages may intentionally have no worktree. Tool groups are:

- `source.*`: read issue/PR/check state; manage allowed labels, comments, acceptance criteria, hierarchy, dependencies, and PR metadata.
- `run.*`: report progress, rationale summaries, blockers, questions, results, artifacts, and milestones.
- `workspace.*`: obtain safe workspace/base/branch metadata, request scoped fetch/push operations, and record workspace artifacts.
- `delivery.*`: inspect configured checks, merge readiness, deployment observations, and stage-specific delivery state.

The server validates scope, permissions, schemas, and idempotency keys. Every mutation is journaled before execution and reconciled afterward. Agent-visible source guidance is supplied by the source plugin so instructions remain exact for GitHub without contaminating the generic engine.

Agents may use harness-native subagents. Only the lead reports to Conveyor or mutates the source. Cost and duration that the harness cannot attribute to subagents are assigned to the lead run; subagents appear with zero separately attributable cost.

## 14. Reliability and recovery

Every run has a durable ID, attempt number, lease, heartbeat, process metadata, log path, and persisted events.

- Stage advancement occurs only after exit-verifier success, successful configured lifecycle actions, a durable checkpoint, and confirmed source-label transition.
- A process crash or lost heartbeat marks the attempt interrupted and schedules a fresh attempt at the same stage with exponential backoff. Consecutive infrastructure failures use their own configurable limit, default five, then block with diagnostics.
- An intentional Conveyor/VPS shutdown interrupts and later resumes the attempt without consuming an infrastructure retry.
- Existing worktree changes are preserved.
- A runner session may be resumed when safely supported, but correctness never depends on conversational session recovery.
- Usage-limit detection records a waiting state and next retry time, then automatically retries the same configured runner with backoff and jitter. Its retry count is unlimited by default and never falls back to another runner.
- There is no fallback harness in v0.1.
- Source mutations use idempotency records so replay cannot duplicate children, comments, labels, or PRs.
- Merge intent and the managed PR identity are journaled before the merge call so a closing webhook race can always be correlated with the expected post-merge path.
- Webhooks drive prompt updates; periodic reconciliation repairs missed, reordered, or duplicated events.
- Interruption sends a graceful termination signal, waits a configurable short deadline, then force-kills the process tree while preserving logs and workspace files.
- Graceful service shutdown stops admitting work, interrupts child processes, persists state, and releases leases.

## 15. GitHub synchronization

The GitHub adapter listens for issue, label, comment, subissue, dependency, pull-request, check/workflow, deployment, and deletion/transfer events relevant to configured repositories.

Deletion or transfer out of a configured repository interrupts local execution immediately, removes the item from active projections, and preserves its audit history. It performs no follow-up source mutation.

Reconciliation compares GitHub with the SQLite projection. Source facts win. Conveyor-owned queue rank, attempts, logs, and cost remain local facts.

When source state and labels disagree, the UI shows both and an explicit warning. Examples include:

- Closed issue carrying an active pre-merge stage label.
- Done issue still open and therefore closable.
- Multiple configured stage labels.
- Missing parent, dependency, branch, or PR.
- PR merged outside the expected pipeline.

Conveyor does not silently repair an ambiguity that could restart or skip work. Safe creation of missing configured labels and refresh of Conveyor's own status comment are allowed while the issue is active.

## 16. Web UI

The UI is an operations console, not a general Kanban editor. It is implemented as server-rendered Preact components. V0.1 ships no client hydration bundle; links and forms retain simple HTTP semantics.

Primary views:

- A single horizontally scrolling Kanban row with exactly one column for every configured stage, including the first stage. Statuses never create columns; they appear as card badges, border colors, and reasons.
- Global backlog ordering for top-level items waiting at the first configured stage.
- A separate needs-attention view for enrolled issues with a missing, unknown, or conflicting stage label. Such issues never disappear from the UI and are not guessed into a stage.
- Hierarchical parent/child roll-ups.
- Waiting for input.
- Blocked, rejected, needs-intervention, done, closable, paused, and source-closed status presentation on cards.
- Run, stage, repository, issue, agent, and total cost summaries.

Every card links directly to its source issue. Issue detail shows:

- Current source state and labels, projected stage, and inconsistencies.
- Parent, children, dependencies, and global/sibling order.
- Acceptance criteria.
- Why the current action is running and what the agent is doing.
- Lead agent, runner, model, effort, duration, attempt, and feedback cycle.
- Sanitized command/tool activity and concise rationale summaries, never private chain-of-thought.
- Logs, artifacts, branch, PR, checks, deployment, and merge state.
- Questions and answer controls.
- Blocker reason and exact required action.
- Event timeline and cost breakdown.

Live updates use server-sent events with polling fallback. One Conveyor status comment per issue, identified by a hidden stable marker, is updated on meaningful transitions and debounced progress intervals to reflect stage, attempts, blocker, PR/deployment, and cost without exhausting source rate limits. If deleted, it is recreated on the next active synchronization. Separate comments are reserved for questions, rejection, and final outcome to avoid conversation spam.

Authentication is one configured username/password. Password verification uses a strong stored hash; login attempts are rate-limited; sessions use signed, HTTP-only, secure, same-site cookies with CSRF protection. The GitHub webhook endpoint is outside the login middleware and requires GitHub HMAC verification. Cloudflare Tunnel may expose the single HTTP service.

## 17. Cost and usage reporting

The engine always measures wall-clock duration. Runners normalize any available usage into:

```json
{
  "durationMs": 12345,
  "usage": {
    "inputTokens": 0,
    "outputTokens": 0,
    "cachedTokens": 0
  },
  "cost": {
    "amount": 0,
    "currency": "USD",
    "source": "reported"
  }
}
```

Cost source is one of `reported`, `calculated`, or `unavailable`. When a runner exposes tokens but not money, optional configured price tables calculate an estimate. Without either, amount is zero with source `unavailable`; the UI must not imply that the run was truly free.

Reports aggregate by run, attempt, stage, issue, repository, lead agent, runner, model, day, and all-time total. Subscription-backed executions may intentionally configure monetary cost as zero while retaining usage and duration.

## 18. Minimum database model

The initial schema contains:

- `config_snapshots`, `repositories`, and `source_cursors`
- `source_events` and `source_mutations` with delivery/idempotency keys
- `issues`, `issue_relationships`, and `dependencies`
- `enrollments`, `workspaces`, and `pull_requests`
- `queue_ranks`
- `stage_states`, `stage_attempts`, `stage_transitions`, and `feedback_cycles`
- `runs`, `run_leases`, and `run_events`
- `questions` and `answers`
- `artifacts` and `log_files`
- `usage_cost_entries`
- `web_sessions`

All workflow-changing writes are transactions. Migrations are numbered, automatic on startup, and backed up before applying a destructive migration. SQLite foreign keys and busy timeouts are enabled. A configurable online SQLite backup runs daily by default and retains seven copies.

Raw logs rotate and compress at a configurable size. V0.1 does not delete audit summaries, cost records, or raw logs unless an explicit retention policy is configured; the UI warns when configured data storage crosses its warning threshold.

## 19. Security assumptions

This is a trusted single-user VPS tool, not a hostile multi-tenant execution service.

- Codex receives automatic approvals and workspace-write access scoped to the issue worktree plus the minimal Git worktree administrative path required for local commits; the primary checkout's files remain outside writable scope.
- Reviewers receive read-only workspace access.
- Process environment is allowlisted per runner; web/session and source API credentials are never passed to agents or ordinary scripts. A deployment script receives only secrets explicitly allowlisted for that script.
- Repository paths are resolved and validated against configured absolute paths.
- Commands are argument arrays, not shell-concatenated strings.
- Logs redact configured secret patterns and environment values.
- MCP authorization is run-scoped and expires with the run.
- UI writes, source mutations, runner starts/stops, and merges are audited.

This limits accidental damage but is not a security boundary against malicious repository code.

## 20. Definition of done for v0.1

V0.1 is complete when a configured GitHub issue can demonstrate this path after a service restart at any point:

1. Adding `conveyor` enrolls it, creates a clean worktree, and places it in the global backlog.
2. A configurable refinement agent creates verified acceptance criteria, labels, dependencies, and optional refined children.
3. A child or leaf progresses through arbitrary configured script/agent stages in a worktree.
4. Every stage runs configured enter and exit checks; failed verification returns actionable feedback to the correct producer within the configured limit.
5. A structured question pauses without occupying a runner and can be answered in the UI.
6. A configured source action opens one PR after implementation; a read-only reviewer checks current requirements and mergeability.
7. A configured source-action stage squash-merges after all configured pre-merge stages succeed.
8. Repository-specific post-merge stages deploy/verify or explicitly skip.
9. The issue becomes done, and becomes closable if GitHub did not close it.
10. Parent roll-ups, dependency eligibility, label-state precedence, pause/reactivation, full offboarding/re-enrollment, crash recovery, status comments, live UI state, logs, cleanup, and cost totals behave as specified.
11. Conveyor never closes an issue and never modifies the repository's primary checkout.

## 21. Implementation order

1. Config loader/schema, SQLite migrations, event journal, and repository registry.
2. GitHub source adapter, webhook verification, reconciliation, labels, and status comments.
3. Scheduler, concurrency permits, durable attempts, process supervision, and retry recovery.
4. Worktree manager and generic JSON-process runner.
5. Scoped MCP server and Codex runner.
6. Configurable stages, evidence scripts, verifier feedback loops, and questions.
7. Hierarchy, dependencies, global queue ordering, PR creation, review, and squash merge.
8. Minimal server-rendered UI, SSE updates, login, steering, logs, and cost reports.
9. Cleanup/finalization, systemd packaging, Cloudflare Tunnel documentation, and end-to-end restart tests.

## 22. Reference interfaces

- Codex non-interactive execution: <https://learn.chatgpt.com/docs/non-interactive-mode>
- GitHub subissues API: <https://docs.github.com/en/rest/issues/sub-issues>
- GitHub issue dependencies API: <https://docs.github.com/en/rest/issues/issue-dependencies>
- GitHub webhook events: <https://docs.github.com/en/webhooks/webhook-events-and-payloads>
- Bun SQLite: <https://bun.com/docs/api/sqlite>
- Model Context Protocol TypeScript SDK: <https://github.com/modelcontextprotocol/typescript-sdk>
