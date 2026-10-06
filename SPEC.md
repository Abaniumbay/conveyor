# Conveyor v0.1 — Product and Engineering Specification

Status: Draft for review  
Runtime: Bun + TypeScript  
Primary source adapter: GitHub  
Persistence: SQLite + filesystem logs

Execution model: every stage is a task chain, `actions` followed by a deterministic `exit-gate` (GitHub issue #19). The earlier `run` / `enterCheck` / `exitCheck` stage shape with AI verifier agents is **legacy**: deprecated but still supported through a compatibility compiler. Text that applies only to it is marked *Legacy*.

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
6. The engine contains no hardcoded delivery stages. Stages, task chains, agents, scripts, retry limits, labels, and status presentation come from configuration.
7. Source mutations made by agents go through Conveyor's MCP tools. Agents do not call the issue source directly.
8. No container-per-issue isolation is used. Code work happens only in Git worktrees; the repository's primary checkout is never modified.
9. Completed task executions are durable journal records. A process failure never repeats a completed action; an interrupted action is reconciled (observe external state, do only the missing work). Only an explicitly configured `onFail` route (`retry` or `return`) may reopen a producer stage.
10. Cost is observed and reported, never used to enforce a budget or stop work.
11. Review agents do not change code. They record criterion approvals and review findings, and the deterministic gate returns actionable feedback to the implementation agent.
12. Requirement changes do not interrupt an active run. A later review/check evaluates the latest issue state and sends outdated work back for correction.

## 3. Product boundary

### Included in v0.1

- One Bun service containing the web server, webhook receiver, reconciler, scheduler, process supervisor, MCP server, and SQLite access.
- GitHub issue source adapter.
- Codex CLI agent runner.
- Generic JSON-returning process runner; bundled examples and checks use TypeScript.
- Configurable sequential pipelines whose stages are task chains: `actions` followed by a non-empty deterministic `exit-gate`.
- A task registry that serves both the stage executor and the agent MCP surface.
- Durable retries, waiting, questions, costs, logs, worktrees, hierarchy, and dependencies.
- Minimal authenticated web UI with live status, backlog ordering, questions, steering, history, and costs.
- Automatic PR creation and squash merge when the configured pipeline permits it.
- Repository-specific script or agent stages for testing, deployment, and verification.

### Explicitly excluded from v0.1

- A general DAG workflow engine.
- Multiple web users, roles, password management, or external identity providers.
- Container or VM isolation.
- A built-in code editor or full GitHub replacement.
- Claude and OpenCode harness implementations. The harness interface is defined, but Codex is the only built-in agent harness.
- GitLab or other item, code or CI provider implementations. The provider roles are defined, but GitHub (and GitHub Actions for CI) is the only built-in implementation.
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

SQLite is an operational journal and projection, not the issue source of truth. It stores scheduling order, leases, attempts, events, questions, costs, source cursors, cached source data, and the durable execution state of task chains (item contexts and history, task executions, stage cursors and epochs). Reconciliation must be capable of rebuilding the source projection.

Unauthenticated liveness and authenticated readiness/diagnostic endpoints report process, database, scheduler, disk, webhook, and last-reconciliation health without exposing issue content or secrets. The UI shows degraded repositories without stopping healthy repositories.

## 5. Plugin contracts

The core orchestrator knows only these roles:

### Providers by role

Each repository selects, by configuration, one provider per role. GitHub is the only implementation; the seams are real.

- **Items** (issue tracker): provides repositories, items, labels, comments, managed body sections, parent/child relationships, dependencies, webhooks, and reconciliation.
- **Code**: branches, change requests (pull requests), native review, mergeability, and merge.
- **CI**: discovers whether CI is defined for a change head, starts label-triggered runs, lists runs and reads logs.

The GitHub item provider uses the configured `gh` authentication for v0.1. On repository onboarding it creates missing configured Conveyor/project labels, validates the existing checkout, and installs or validates the repository webhook. Missing permissions put the repository into a visible misconfigured state and prevent scheduling; webhook failure may fall back to reconciliation when API read access still works.

### Harness

Starts, observes, interrupts, and reports a unit of agent or process execution. V0.1 supplies:

- `codex`: an agent harness using Codex CLI in non-interactive mode. It advertises a `sessionResume` capability, so an agent that asked a question can continue its session with the answer.
- `json-process`: a generic command runner whose stdout is one validated JSON result, used by `script.run`.

Harness-native subagents are allowed within an agent run, but they remain part of the lead run and do not become independent Conveyor runs.

### Task

A task is a named unit, `group.camelCase`, in the registry (`src/tasks/<group>.ts`). The groups are `item`, `workspace`, `change`, `ci`, `agent`, `script` and `conversation`, plus the deprecated `legacy` group. The generated reference is `docs/tasks.md`. There are four kinds:

- **load**: the sole writer of one provider snapshot of the item context (`item`, `workspace`, `change`, `ci`). Safe to re-run. Loads are implicit and never appear in a stage list.
- **check**: a pure function of the context keys it declares in `reads`. No I/O, no writes. Returns `pass`, `pending(message, { after })` or `fail(message, { details, route })`. Only checks appear in an `exit-gate`.
- **act**: reconciles external state toward a desired result (observe first, do only the missing work), declares the snapshots it `invalidates`, and is safe to resume after a crash. Only acts appear in `actions`.
- **tool**: callable only through an agent's scoped MCP grant (see section 13). Never listed in a stage.

Every task declares `reads`, `writes` (loads and engine-captured outputs only) and `invalidates`. A task sees a deep-frozen copy of only the keys it reads. A provider snapshot has one writer, its load task; acts never patch it, they invalidate it and the engine reloads before the next reader. `agent` and `script` are engine-captured act outputs and `checkpoints` is engine-owned. Tasks never sleep or poll: "not yet" is the `pending` result and the engine waits. The configuration compiler validates task kinds, dataflow on every conditional path, unique instance ids and routes, and emits the expanded plan, including implicit loads, to `conveyor config check`.

### Stage

A stage is configuration tying together `id`, `concurrency`, `retries` (default 2), an optional `childrenStartAt`, an `actions` list, and a non-empty `exit-gate` list. It has no semantics beyond its tasks; the engine assigns none to a stage name. Execution is specified in section 8. *Legacy:* a stage may instead be written with exactly one producer (`run`: an agent, a JSON process or a source action), enter and exit checks, concurrency, labels, retry policy and `afterSuccess` lifecycle actions; the compatibility compiler turns it into a task plan (section 8, Legacy lifecycle).

## 6. Configuration

Configuration lives in the Conveyor home (`<home>/config`, often a private Git repository), outside the installed executable and the managed repositories. It has exactly one entrypoint, `conveyor.yaml`, which holds everything or places content in other files with tags written where the content belongs:

```yaml
settings: { runners: 4 }
web: { listen: 127.0.0.1:7788, publicUrl: https://conveyor.example.com }
providers: !include providers.yaml              # the file's content
harnesses: !include builtin:harnesses.yaml      # a packaged default
agents: !include_dir_merge_named agents/        # the maps of every file, merged; duplicate keys are an error
pipelines: !include pipelines.yaml
repositories: !include_dir_named repositories/  # one file per repository, named by its id
```

`!secret <key>` takes a value from `secrets.yaml` beside the entrypoint, which is never committed; secret values are redacted from every display, export, log and stored snapshot. Paths in tags, and relative paths inside an included file, resolve from the file that declares them. Includes nest; a cycle, a duplicate key from a directory tag, or a missing secret is an error naming the file and key path. All files are composed and schema-validated at startup. An invalid configuration prevents the service from starting and reports the file and key path of each error. Restarting the service is required after a configuration change. With a home, unset state paths default to `<home>/state/conveyor.sqlite`, `<home>/logs`, `<home>/worktrees` and `<home>/artifacts`, and the dashboard listens on `127.0.0.1:7788`.

A configuration directory of YAML files merged by key (with `settings`, `web` and `labels` declared once) is deprecated: it still loads, with its v0.1 defaults (state under `<directory>/data`, port 4300), and `conveyor config migrate` converts it to an entrypoint whose compiled plans and effective configuration are verified identical.

The validated configuration receives a content hash stored with every run and with every item context. A removed/renamed current stage or incompatible label mapping blocks that issue with a configuration-drift warning instead of guessing a migration. When the hash changed and an item is parked mid-stage under the old plan, the stage restarts from its beginning under a new epoch with one conversation note; it is never resumed against a plan that may not contain its cursor (section 8, Durable execution).

### Canonical names

The canonical configuration names the three provider roles and the harnesses: `providers.items` (issue trackers), `providers.code`, `providers.ci`, `harnesses`, agent `harness` and `access`, and repository `items` and `code`. The loader translates them to the older names (`sources`, `codeHosts`, `ci`, `runners`, `runner`, `workspaceAccess`, `source`, `codeHost`), which keep working. Using the old and the new name for the same thing is an error, and equivalent documents produce the same hash. `labels` may sit on the item providers (every one must carry an identical block) or at the top level.

### Task entries, guards and overrides

A task entry has `id`, `task`, `with`, `wait`, `onFail` and `when`. `id` defaults to the task name when that name occurs once in the list and is required otherwise; instance ids are unique within a stage. Overrides, execution records, script results and idempotency keys address the instance id, never an array index or task name. `with` is validated against the task's schema at load time. `wait` is `{ timeout, poll }` (`timeout: unlimited` never expires); each field comes from the repository override, else the entry, else the task's own default, else `settings.taskDefaults.wait` (default timeout 30m, poll 1m). `onFail` is `retry`, `{ return: <stage> }` or `{ stop: <state> }` (section 8). `when` is a guard from a closed vocabulary, `ci.enabled`, `ci.required` or `ci.advisory`, evaluated at load time from the repository's CI mode; a task whose guard is false is left out of the plan, and an exit gate must still be non-empty. There are no expressions, loops, variables or message templates.

A repository changes a task without copying the pipeline through `overrides.stages.<stage>.<actions|exit-gate>.<instance id>` (`with`, `wait`, `onFail`). Naming a stage, list or instance that does not exist is an error. A repository may declare `agentEgress` (section 19; optional, and without it agents get the sanitized environment only); these are security inputs, not task expressions. A repository's `ci` is `{ provider, mode: required | advisory | disabled, ignoreChecks }` (section 8, CI modes).

Settings added by task chains: `maxReturns` (default 5, the cross-stage `return` budget), `taskDefaults.wait`, and `history.contextSummaryBytes` (default 65536, the bound on the stored item context).

### Packaged defaults (and the deprecated import)

The reference configuration (providers, harnesses, agents with exact task grants, the `delivery` and `midgame-delivery` pipelines and the agent instructions) is versioned in this repository under `examples/config`, one section value per file, and embedded in every release executable. An entrypoint selects a file with `!include builtin:<file>`; packaged files are materialised under `<home>/state/builtin/<digest>/` so agents can read instructions by path, and their content is part of the configuration hash. A section either includes a packaged default or is the operator's own; there is no merging of defaults with overrides beyond repository task `overrides`.

A local file may still import a directory of a Git checkout at a pinned ref (`import: { repository, ref, path }`), read with `git ls-tree` and `git show` and materialised under `<settings.artifacts>/config-imports/<sha>/`. This is deprecated in favour of packaged defaults: it loads with a warning, and `conveyor config migrate` inlines it. `conveyor config compare` prints two configurations' compiled plans side by side with a summary of added, removed and changed tasks, routes and waits.

Illustrative native configuration (the shape of the reference configuration; not a built-in pipeline):

```yaml
settings:
  runners: 4
  database: /srv/conveyor/state/conveyor.sqlite
  logs: /srv/conveyor/state/logs
  workspaces: /srv/conveyor/state/worktrees
  artifacts: /srv/conveyor/state/artifacts
  reconcileInterval: 5m
  maxReturns: 5
  history:
    contextSummaryBytes: 65536
  retries:
    infrastructureAttempts: 5
    usageLimitAttempts: unlimited
    minBackoff: 30s
    maxBackoff: 30m
  taskDefaults:
    wait: { timeout: 30m, poll: 1m }

web:
  listen: 127.0.0.1:4300

providers:
  items:
    github:
      type: github
      webhookPath: /hooks/github
      autoConfigureWebhook: false
      labels:
        enrollment: conveyor
        stageTemplate: "conveyor:{stage}"
        states:
          done: conveyor:done
          blocked: conveyor:blocked
          rejected: conveyor:rejected
          error: conveyor:error
          needs-input: conveyor:needs-input
          needs-intervention: conveyor:needs-intervention
        metadata:
          closable: conveyor:closable
          orderTemplate: "conveyor:order:{number}"
  code:
    github: { type: github }
  ci:
    actions: { type: github-actions }

harnesses:
  codex:
    type: codex
    command: codex
    sandbox: workspace-write
    automaticApprovals: true
  process:
    type: json-process

agents:
  refiner:
    name: Refiner
    title: Product Owner
    harness: codex
    effort: high
    instructions: ./instructions/refiner.md
    access: read-only
    tasks: [item.get, item.guidance, workspace.get, conversation.get, agent.reportProgress,
            agent.askQuestion, item.comment, item.setCriteria, item.setTitle, item.setSystemLabels,
            item.setParent, item.setDependencies, item.createChild]
  implementer:
    name: Implementer
    title: Software Engineer
    harness: codex
    effort: high
    instructions: ./instructions/implementer.md
    access: workspace-write
    tasks: [item.get, item.guidance, workspace.get, change.get, ci.getLogs, conversation.get,
            agent.reportProgress, agent.askQuestion, workspace.fetch, workspace.push,
            change.listFindings, change.comment, change.resolveFinding]
  reviewer:
    name: Reviewer
    title: Senior Reviewer
    harness: codex
    effort: high
    instructions: ./instructions/reviewer.md
    access: read-only
    tasks: [item.get, workspace.get, change.get, ci.getLogs, conversation.get, agent.reportProgress,
            change.listFindings, change.comment, change.resolveFinding,
            change.checkCriterion, change.uncheckCriterion]

pipelines:
  default:
    stages:
      - id: refinement
        concurrency: 3
        retries: 2
        childrenStartAt: next
        actions:
          - { id: refine, task: agent.run, with: { agent: refiner } }
        exit-gate:
          - { id: criteria, task: item.criteriaDefined }
          - { id: labels, task: item.labelsValid }
          - { id: children, task: item.childrenValid }
          - id: dependencies
            task: item.dependenciesMet
            wait: { timeout: unlimited, poll: 5m }
      - id: implementation
        concurrency: 2
        retries: 3
        actions:
          - { id: workspace, task: workspace.ensure }
          - { id: implement, task: agent.run, with: { agent: implementer } }
          - { id: ensureChange, task: change.ensure, with: { closingReference: true, criteriaChecklist: true } }
          - { id: startCi, task: ci.start, when: ci.enabled }
        exit-gate:
          - { id: pushed, task: workspace.pushed }
          - { id: criteriaSynced, task: change.criteriaInSync }
          - { id: ciDefined, task: ci.defined, when: ci.required, onFail: { stop: blocked } }
          - { id: ciGate, task: ci.passed, when: ci.required, wait: { timeout: 3h, poll: 1m } }
      - id: review
        concurrency: 1
        actions:
          - { id: review, task: agent.run, with: { agent: reviewer } }
        exit-gate:
          - { id: findings, task: change.findingsResolved, onFail: { return: implementation } }
          - { id: criteriaApproved, task: change.criteriaChecked, onFail: { return: implementation } }
          - { id: ciHead, task: change.headUnchanged, when: ci.required, onFail: { return: implementation } }
          - { id: mergeable, task: change.mergeable, wait: { timeout: 30m, poll: 1m }, onFail: { return: implementation } }
      - id: merge
        concurrency: 1
        actions:
          - { id: mergeReviewedHead, task: change.merge, with: { method: squash } }
        exit-gate:
          - { id: merged, task: change.merged, onFail: { return: implementation } }
      - id: deploy
        concurrency: 1
        actions:
          - { id: deployScript, task: script.run, with: { script: ./stages/deploy.ts, recovery: reconcile } }
        exit-gate:
          - { id: deployed, task: script.succeeded, with: { run: deployScript }, onFail: { stop: needs-intervention } }

repositories:
  example:
    items: github
    code: github
    ci: { provider: actions, mode: required, ignoreChecks: [] }   # required | advisory | disabled
    address: example/project
    folder: /srv/repositories/project
    baseBranch: main
    pipeline: default
    concurrency: 2
    agentEgress:
      allowLoopbackMcp: true
      httpsHosts: [registry.npmjs.org]
    overrides:
      stages:
        deploy:
          actions:
            deployScript: { with: { script: /srv/conveyor/stages/deploy-example.ts, recovery: reconcile } }
```

Secrets are environment variables and never appear in YAML:

- `CONVEYOR_USERNAME`
- `CONVEYOR_PASSWORD_HASH`
- `CONVEYOR_SESSION_SECRET`
- `CONVEYOR_GITHUB_WEBHOOK_SECRET`
- Any harness/provider credentials not already supplied by the CLI environment

### Legacy configuration (deprecated)

The earlier shape remains loadable: `sources`, `codeHosts`, `runners`, a top-level `labels`, a `checks:` section (a deterministic script plus an AI verifier agent), and stages written with `run`, `enterCheck`, `exitCheck`, `feedbackCycles`, `failurePolicies`, `failureState` and `afterSuccess`. A stage is either native or legacy, never both, and a pipeline with legacy stages still requires `successStatuses` and `failureStatuses`. It compiles to `legacy.*` tasks and runs through the same durable executor. Legacy `process` scripts carry no recovery declaration, so they stay behind the legacy adapter until classified `replay-safe` or `reconcile`. The shape and the AI verifier are to be removed once every repository is migrated. Illustrative legacy configuration:

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
  steering:
    agent: operator
    workspace: /srv/conveyor/operator

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
  refiner:
    name: Refiner
    title: Product Owner
    runner: codex
    model: configured-model-name
    effort: high
    instructions: ./instructions/refiner.md
  implementer:
    name: Implementer
    title: Senior Developer
    runner: codex
    model: configured-model-name
    effort: medium
    instructions: ./instructions/implementer.md
  reviewer:
    name: Reviewer
    title: Senior Reviewer
    runner: codex
    model: configured-model-name
    effort: high
    instructions: ./instructions/reviewer.md
    workspaceAccess: read-only
  checker:
    name: Verifier
    title: Quality Verifier
    runner: codex
    model: configured-model-name
    effort: high
    instructions: ./instructions/checker.md
    workspaceAccess: read-only
  operator:
    name: Operator
    title: Conveyor Operator
    runner: codex
    model: configured-model-name
    effort: medium
    instructions: ./instructions/operator.md
    workspaceAccess: workspace-write

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
          agent: refiner
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
3. A closed source issue is stopped immediately and no further delivery work is scheduled. It appears in the Done lane while its source close reason distinguishes completed work from other closure.
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

## 8. Stage execution, gates and durable state

### Stage semantics

A stage is two task lists run for one item by the stage executor:

1. **`actions`** do the stage's job, in order. Before each task the engine runs the load task for every snapshot key the task reads that is not loaded or was invalidated by an earlier act. A passing act's output is captured only for engine-captured keys, and the snapshots it invalidates are marked stale.
2. **`exit-gate`** proves the job is done. On entering the gate (and re-entering after a park) nothing it reads is trusted; checks run in order and the first that does not pass decides. When every check passes the gate is open, gate-scoped checkpoints are recorded, the cursor is cleared, and the item advances: Conveyor records the pending source transition and the next stage becomes schedulable only after the source label change is confirmed.

There are no entrance gates. Conditions the next stage requires belong to the previous exit gate. A person may relabel an item straight into a stage and so skip that gate; acts therefore validate their own safety preconditions (for example `change.merge` checks the reviewed head and `workspace.ensure` checks the workspace).

A task returns `pass`, `pending` or `fail`. A thrown error is an infrastructure error, not a domain failure, and uses the bounded infrastructure and usage-limit retry policy without consuming a stage retry. Retries back off exponentially from `settings.retries.minBackoff`, doubling up to `maxBackoff`. After `infrastructureAttempts` consecutive failures of the same stage the item stops as `error`, with one conversation note giving the reason; usage-limit failures (runner usage limits, provider rate limits) are bounded by `usageLimitAttempts` instead, which defaults to unlimited. A successful execution resets the count.

### Waiting

`pending` means "not yet" (CI still running, a dependency not satisfied, an agent asked a question). The engine persists the cursor (list, task instance, state `pending`), the time it first became pending, the next wake-up and the deadline, releases all permits and sets one board status line; repeated polls do not post conversation messages. The item is woken after the task's `wait.poll` (or the `after` the check supplied) or earlier by a provider webhook, an answered question or an operator action. `wait.timeout` runs from the first pending time and survives restarts; at expiry the task fails with "did not finish within <timeout>" and is routed by its `onFail`. Dependency waiting has no timeout unless configured.

- A pending **action** keeps the cursor on that task. Completed earlier actions are replayed from the journal, not repeated. An act past its deadline is not invoked again.
- A pending **gate check** parks the item; later the whole gate is re-evaluated with fresh loads and the actions are not repeated.

### Routing: onFail, retries, maxReturns

A failing task is routed, in order, by the route the task result carries, the instance's `onFail`, or the list default:

- `retry` (default for an exit-gate failure): run the stage's actions again as the next attempt with the failure message and details as `run.feedback`, while the attempt number is at most `retries` (so a stage makes up to `retries + 1` attempts). When retries are exhausted the stage stops as `blocked` with the last failure. Usage-limit and infrastructure retries do not count.
- `{ return: <stage> }`: leave this stage and return to another stage of the pipeline (normally an earlier one; the compiler rejects an unknown stage and the stage's own id) with the failure as required fixes and evidence. The number of returns is counted per item in the context; reaching `settings.maxReturns` stops the item as `blocked` with a loop-guard reason. The counter resets when the item leaves the pipeline or is stopped, so a person's unblock starts with a fresh budget.
- `{ stop: <state> }` (default for an action failure is `stop: blocked`): stop the item in a `labels.states` state with the failure reason as the required action.

Stage execution posts conversation messages only for failures, routing and stops. The one-time CI start announcement and the single final advisory-CI result are the explicit engine-owned exceptions. A conversation message holds at most 4,000 characters. An owner's message over the limit is rejected where it is typed; a longer message from Conveyor or an agent (for example a CI failure with log excerpts) keeps its beginning and is trimmed with a note of how much was cut, so reporting a failure never fails the stage.

### Producers: agents and scripts

`agent.run` runs a configured agent through its harness in the item's workspace and captures `{ agentId, status, summary, reason, sessionId, runId }`. Its outcome never opens a gate by itself:

- `done` passes the action; the exit gate decides whether the work is complete.
- `needs-input` parks the action until the question is answered, then continues the agent's session when the harness advertises `sessionResume` and otherwise starts a fresh attempt that carries the original question and answer. Both paths end in the same captured result; correctness never depends on session resume.
- `blocked` and `rejected` stop with the agent's reason.
- `changes-requested` passes only when the run recorded at least one review finding with `change.comment`; without a finding the result is invalid and stops as an error.
- Any other or invalid structured result stops as an error with an actionable reason.

`script.run` runs a repository script with the script protocol on stdin and must declare `recovery: replay-safe | reconcile`; the compiler rejects a `script.run` without it. `replay-safe` is for side-effect-free checks, observations and no-op deploys and is applied again after a restart. `reconcile` passes a stable idempotency key to the script and gives it an `observe` phase: after a restart the engine observes first, records `already-applied` as complete, applies only after `not-applied`, and stops as `needs-intervention` on `indeterminate` instead of repeating an external effect. `script.run` itself passes whenever the script completes; its bounded result is stored per instance and `script.succeeded` fails the gate, with the summary, when the script reported failure. The protocol is in `docs/tasks.md`.

### No AI verifier

Native stages contain no AI verifier. The AI verifier agent and the `checks:` section are legacy-only, behind `legacy.enterCheck` and `legacy.exitCheck`. Deterministic checks own every gate over structured evidence; judgement lives in the refiner, implementer and reviewer agents, and the reviewer's judgement reaches the gate only as criterion approvals and findings (Review evidence, below).

### Durable execution

- **Context.** One latest context per item is persisted after every completed task with an incremented version, and an append-only history row (version, stage, epoch, task instance, context) is kept per save. It carries `schemaVersion`, `configHash` and the provider snapshots; large logs stay artifacts and only bounded summaries enter the context. Failed CI runs' logs share a fixed budget when loaded and keep their failing-test blocks ahead of the tail. A context over `settings.history.contextSummaryBytes` first has those CI logs shrunk until it fits; only a context still over the limit is an error naming its largest key.
- **Journal and idempotency key.** Before an act mutates anything the engine persists a `planned` execution record keyed by the SHA-256 of item, stage, stage epoch, attempt and task instance, then marks it `running`, and finally `completed` or `failed` with the result. A key alone is not enough: on resume the act is told it was resumed, observes external state, performs only the missing work, and the engine replays an already completed execution's stored result instead of running it again. This closes the window between an external side effect and the local commit.
- **Reconcile.** Provider acts (`change.ensure`, `change.merge`, `workspace.ensure`, `workspace.cleanup`, `ci.start`) observe first (an existing change request, an already merged change, an existing worktree, a marker for a rerun already issued). Mutating MCP tool calls use the same journal keyed by run, tool name and the hash of the input, so a retried call returns the stored response and cannot duplicate a comment, relationship or push.
- **Epochs and fencing.** Each item has a stage epoch. Every stage, state or enrollment change bumps it and drops the cursor in one transaction. Every context and journal write is fenced by the epoch the executor started with; a late task from before a pause, relabel or return fails the fence and the run ends as superseded without mutating or advancing the item.
- **Cursor.** The stage cursor records stage, epoch, attempt, return count, current list and task instance, state (`planned`, `running`, `pending`, `completed`), feedback, and the pending time, wake-up and deadline. A restart resumes from it.
- **Checkpoints.** `ci.passed` records `checkpoints.ciPassed` with the head SHA when required CI passes. When the complete review gate passes (`change.findingsResolved`, `change.criteriaChecked`, `change.headUnchanged`, `change.mergeable`) the engine records `checkpoints.reviewPassed` atomically with the head SHA. `change.merge` squashes only when the live head equals `reviewPassed.sha` and, when CI is required, `ciPassed.sha`; otherwise it stops as `blocked`.
- **Restart on config change (plan change).** When the stored context's `configHash` differs from the running configuration and the item has a cursor in the stage, the stage restarts from the beginning under a new epoch with one note ("The pipeline plan changed since <stage> started; the stage restarted from the beginning."). This applies to every item parked mid-stage when the hash changes, whether or not its own stage plan changed. Completed acts are reconciled, not repeated, so the restart does not duplicate pushes, pull requests or merges. Migrate and roll back while the board is idle.

### CI modes

A repository's CI `mode` is `required`, `advisory` or `disabled` (default `required`):

- **required.** The implementation stage runs `ci.start` (starts label-triggered runs, reruns a cancelled run once per head, announces CI once per head) and its gate requires `ci.defined` then `ci.passed`. `ci.defined` fails as `blocked` when no applicable CI definition exists or the provider cannot prove whether one does: no CI is never success, so a deleted workflow cannot weaken the gate. `ci.passed` handles registration settling (default 120 s), queued and running checks, and failures; a red run fails with focused logs and, by default routing, retries the implementation actions. All reported checks of the current head count except `ignoreChecks`. The review gate re-checks the head is unchanged since CI passed. Defaults: timeout 3 h, poll 1 min (the reference sets 8 h and 5 min for midgame).
- **advisory.** Only `ci.start` runs and the stage advances at once. Starting CI creates, or reuses, one durable watch per (repository, item, head SHA) that persists its settle and timeout deadline, holds no runner or stage permit, survives restarts and is polled by the service every minute. It posts the normal start announcement at most once and exactly one final message: pass, failure with run links and focused logs, or timeout (3 hours). A newer head marks the older watch `superseded` and its final message is never posted; starting the same head again reuses the watch. The result is evidence only and never routes, stops or reopens the item.
- **disabled.** Tasks guarded by `ci.enabled`, `ci.required` or `ci.advisory` are omitted and no CI provider is needed.

### Review evidence

Review evidence is bound to the change head; the pull request is its projection.

- **Criterion approvals.** `change.checkCriterion` records `{ criterionId, reviewer, headSha, checkedAt }` (and the criterion's text hash) in Conveyor and then ticks the checklist in the pull request; `change.uncheckCriterion` withdraws it. A new head, or edited criterion text, invalidates earlier approvals. `change.criteriaChecked` requires every non-manual criterion (text starting `[Manual]` is manual) to be approved for the current head. The Markdown checklist is not authoritative; `change.criteriaInSync` only verifies it lists the item's criteria ids.
- **Findings.** A finding is a provider-neutral record with an id, a provider key when imported, author, source (`agent` or `human`), head SHA, state, location and URL. States: `open`, `resolved`, `dismissed`, `withdrawn`; every change is kept in an audit trail. A reviewer records one with `change.comment` (an inline review comment when `path` and `line` are in the diff, otherwise a managed change comment). `change.load` imports native human review: unresolved threads and changes-requested reviews (a changes-requested review without a thread becomes one top-level finding); the provider artifact id is the deduplication key, edits update the same record, resolved threads resolve it, and a deleted artifact becomes an audited `withdrawn` finding. Ordinary conversation comments are not findings. Imported findings stay provider-authoritative: an agent closes one with `change.resolveFinding` (verdict `fixed` or `invalid` and a comment), which replies on the native thread with the verdict, the current head and the agent's name, adds a thumbs up or down, and resolves the thread; the record is resolved only when the thread is, and a thread that is unresolved again reopens it. A changes-requested review has no thread: the agent's answer is a change comment and the record stays resolved. Agent findings get the same reply and reaction on their projection.
- **Gate.** `change.findingsResolved` fails while any finding is open. A reviewer result of `changes-requested` with no recorded finding is invalid. The gate's passing records `reviewPassed`.
- **Operator dismissal.** An operator dismisses an open finding with `POST /api/issues/:issueId/findings/:findingId/dismiss` (signed-in dashboard session, `X-CSRF-Token`, JSON `{ "reason": "..." }`, non-empty reason). The route calls the same task dispatcher as `change.dismissFinding` with the signed-in user as a human actor. `change.dismissFinding` is never grantable to an agent. The authorization is the single dashboard login; `allowedHumanLogins` is not consulted. The web UI has no dismiss control yet.

### Producer results and the run envelope

A producer result has two core outcomes; status names remain configuration-defined. For native stages the consuming task interprets `status` as above; the engine assigns it no other meaning:

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

JSON-process scripts receive a versioned JSON object on stdin containing `phase` (`apply` or `observe`), `idempotencyKey`, `taskInstanceId`, repository, issue, stage, attempt, workspace, context, feedback, and scoped artifact paths. They must emit exactly one schema-valid producer result on stdout; the process runner wraps it in the durable envelope. Scripts may also report usage and monetary cost when known. Human-readable logs go to stderr. Invalid or extra stdout is a runner failure.

### Legacy lifecycle (deprecated)

*Applies only to stages written with `run`, `enterCheck` and `exitCheck`.* The compatibility compiler maps them to `legacy.*` tasks that reproduce this behaviour.

For each stage, the engine performs:

```text
enter evidence -> enter verifier -> producer -> exit evidence -> exit verifier
```

- Enter-check failure stops at the current stage using the check result by default. A status-specific `returnToPrevious` policy may instead return actionable feedback to the preceding stage's producer.
- Exit-check failure returns feedback to the current stage's producer.
- A producer failure normally stops at its configured state. A status-specific `returnToPrevious` policy may instead append its feedback to the preceding producer, which is how a read-only review stage requests code changes.
- The corrected producer reruns in a fresh agent process against the preserved worktree.
- The default maximum is two producer/verifier feedback cycles, configurable per stage.
- Exhaustion produces a configured failure status, normally blocked, with the full reason and required user action.
- Usage limits and infrastructure retries do not consume feedback cycles.

Every producer and verifier evaluates the latest issue content. If requirements change during a producer run, that run continues; the next verifier catches any mismatch.

When an explicitly configured enter-check policy reopens the preceding stage, its earlier successful attempts remain immutable history. Conveyor appends a correction attempt, reruns that stage's exit check, and then reruns the failed enter check. No downstream stage is considered complete until this boundary passes. Infrastructure failures remain on the stage where they occurred.

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

`success` advances to the next stage when `status` is listed in the stage's effective `successStatuses`, inherited from its pipeline unless overridden. `failure` stops or invokes the status-specific configured feedback policy. A `returnToPrevious` correction is the only backward pipeline transition in v0.1; arbitrary jumps and branching are not supported. Status strings have no engine meaning beyond their configured policy and label mapping. For example, already-done normally maps to successful `skipped`, infeasible maps to failed `rejected`, code-review changes map to failed `changes-requested` with `returnToPrevious`, and a question creates run-level waiting state rather than a fabricated stage result.

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

Stable hidden IDs keep approvals and evidence connected when criteria are reordered. Content outside the managed markers is never changed. Content inside the markers remains source-authoritative: writes use optimistic revision checks so a concurrent human edit is re-read and verified rather than overwritten.

The reviewer checks every criterion against the current issue and implementation. Conveyor never marks criteria complete merely because a producer claims success: a criterion is approved only by the reviewer's `change.checkCriterion` call for the current head, recorded in Conveyor, and the pull request checklist is rendered from those approvals. In the legacy shape the configured verifier supplies the decision and the engine applies validated checkbox updates.

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
3. Global `settings.runners` when starting an agent, script, or (legacy) verifier OS process.

The global permit counts live OS-level runner processes; an in-process source action does not consume it. Stage and repository permits count issues currently executing in that scope, including source actions; a producer and verifier for the same issue never overlap. Questions, pauses, automatic backoff, blocked states, and completed attempts hold no permits. Harness-native subagents remain inside the lead runner's single permit.

## 11. Workspace and Git behavior

Each configured repository folder must be an existing accessible Git checkout; v0.1 never clones repositories. On fresh enrollment, an issue receives one clean worktree and branch created from the latest fetched repository base branch, defaulting to `main`. If refinement converts it into a roll-up parent, that temporary worktree is removed and new child worktrees are created. A resumed paused issue reuses its worktree; a fully offboarded and later re-enrolled issue receives a new enrollment generation.

- Conveyor may fetch, create worktrees/branches, commit, and push through runner/MCP operations scoped to the issue.
- It never changes files or branches in the configured primary checkout.
- Branch naming defaults to `conveyor/<issue-number>-r<enrollment>-<slug>`, preventing a stale remote branch from a prior enrollment from being reused accidentally.
- The implementation agent is responsible for keeping its branch current with the base branch before reporting success.
- The review gate checks mergeability (`change.mergeable`, pending while the host computes it, timeout 30 minutes). Conflicts or an outdated branch return to implementation as feedback.
- The idempotent `change.ensure` action pushes the branch and opens the PR (or reuses the existing one) with the criteria checklist; the reference configuration places it in the implementation actions. *Legacy:* `pullRequest.ensure`.
- The `change.merge` action in the merge stage squash-merges only the head the review gate passed (`checkpoints.reviewPassed`), and the gate rechecks the current CI head. *Legacy:* a `pullRequest.squashMerge` source-action stage.
- Formal GitHub PR approval is not submitted by the reviewer; its approval is the internal, SHA-bound set of criterion approvals and findings, projected onto the PR.
- Branch-protection refusal or any merge failure that cannot be repaired within the pre-merge feedback loop becomes blocked or needs intervention.

The PR includes the configured GitHub closing reference. There is one implementation PR per issue enrollment in the normal path. Agents receive no GitHub API token; authenticated fetch/push/PR/merge operations are performed by the engine or scoped MCP/source actions. The implementation agent may make local commits and request safe fetch/push operations through MCP.

Reviewers run with read-only code permissions. Tests or builds that need to write caches/output run in deterministic evidence scripts or configured temporary paths; the reviewer consumes their results and cannot modify source files.

Manual closure normally stops an issue. The narrow exception is an issue closed by the successful merge of its own Conveyor-managed PR: configured post-merge deploy and verification stages continue. This correlation is recorded at merge time; a coincidental/manual closure is never assumed to be a Conveyor merge.

The reference configuration maps a post-merge failure to `stop: needs-intervention` with no retry route. Therefore, if deployment or verification fails after merge, Conveyor does not roll back, modify code, or create a repair PR; it records diagnostics and asks the user to intervene. A clearly classified transient runner/infrastructure failure may still use the separate infrastructure retry policy before the stage is declared failed.

Normal successful terminal processing runs the configured cleanup stage to remove the worktree, transient files, and the local issue branch when it is safe to delete. The cleanup process runs from a service-owned run directory, never from the directory it deletes; its exit verifier receives deterministic cleanup evidence and supports an absent worktree. Local cleanup never deletes a remote branch unless an explicit source action is configured. SQLite history, logs, costs, and declared artifacts remain. Blocked, rejected, needs-intervention, paused, and fully offboarded issues retain their worktree for diagnosis or resumption; stale state is replaced if they are later freshly enrolled.

## 12. Questions and human steering

Any agent may ask a structured question through MCP. Refinement questions are expected; questions in later stages should be exceptional.

A question contains an ID, prompt, reason, zero or more options with stable IDs, minimum/maximum selections, whether free text is allowed, and the requesting stage/run. Only one unanswered question may exist per issue. Conveyor then:

1. Adds the configured needs-input label.
2. Posts the question to the issue conversation.
3. Shows option controls and free text in the web UI.
4. Parks the `agent.run` action (its cursor stays on that task) and releases its permits.
5. Mirrors the web answer back to the issue conversation.
6. Clears needs-input and wakes the stage; the action resumes.

The resumed action continues the agent's own session with the answer when its harness advertises `sessionResume`; otherwise it starts a fresh attempt that receives the current issue, the explicit question/answer, existing workspace, stage feedback, and durable artifacts—but not the previous private chat transcript. Earlier actions in the stage are not repeated.

The web UI is the primary answer path. The question comment contains a hidden question ID; a subsequent non-bot comment from a configured allowed GitHub login is also accepted as the answer while that question is open. UI answers use an idempotent source mutation, so the mirrored bot comment cannot be consumed as a second answer.

The UI provides pause/resume and retry controls. Pause removes only the base label; resume restores it; retry clears a configured nonterminal blocking/error state while preserving the current stage. Done and rejected cannot be restarted accidentally from the UI—the user must deliberately change the source labels. Source-label semantics remain authoritative: controls perform the corresponding label action through the source adapter rather than creating a second state system.

An explicit **Steer** action is different from an ordinary issue edit: it mirrors the instruction into the issue conversation, interrupts the current process, and starts a fresh attempt at the same stage with the preserved worktree and steering instruction. Steering is user-initiated infrastructure control and does not consume a verifier feedback cycle.

## 13. Agent MCP surface

Every agent receives a scoped MCP server for exactly one repository, issue, stage, and run, plus its worktree when that stage has one. Cleanup and source-only stages may intentionally have no worktree. The tools are the registry's `tool` tasks, exposed by task name; the registry owns each tool's schema, implementation and description, and there is no parallel MCP layer. Names are camelCase:

- `item.*`: `get`, `guidance`, `comment`, `setCriteria`, `setTitle`, `setSystemLabels`, `setParent`, `setDependencies`, `createChild`: read the issue and manage its title, allowed labels, comments, acceptance criteria, hierarchy and dependencies.
- `agent.*`: `reportProgress`, `reportRationale`, `reportBlocker`, `reportResult`, `reportMilestone`, `recordArtifact`, `askQuestion`.
- `workspace.*`: `get`, `fetch`, `push`: workspace/base/branch metadata and scoped fetch and push.
- `change.*`: `get`, `setMetadata`, `comment`, `resolveFinding`, `listFindings`, `checkCriterion`, `uncheckCriterion` (and `dismissFinding`, which is never grantable).
- `ci.getLogs`: failing or named CI job logs for the current head.
- `conversation.get`: read the concise shared issue handoff without exposing raw harness logs or private reasoning.
- `todo.*`: `get`, `set`, `update`: the implementer's ordered todo list for the item (stable ids; pending, in_progress or done; at most one in progress). Conveyor stores it, not the repository; it survives across runs and returns to the stage, and the board shows its progress on the card and the checklist in the item's details.

`agents.<id>.tasks` is the exact grant (default: every grantable tool). The legacy snake_case names remain accepted as aliases, in grants (`tools:` is normalised to `tasks`; using both is an error) and in calls: `source.get_issue` is `item.get`, `source.get_guidance` is `item.guidance`, `source.add_comment` is `item.comment`, `source.set_acceptance_criteria` is `item.setCriteria`, `source.set_system_labels`, `source.set_parent`, `source.set_dependencies` and `source.create_child` map to the matching `item.*` tools, `source.set_pull_request_metadata` is `change.setMetadata`, `workspace.get_context`, `workspace.request_fetch` and `workspace.request_push` are `workspace.get`, `workspace.fetch` and `workspace.push`, `delivery.get_state` is `change.get`, `delivery.get_check_logs` is `ci.getLogs`, `run.report_*` and `run.ask_question` are `agent.report*` and `agent.askQuestion`, and `run.record_artifact` and `workspace.record_artifact` are `agent.recordArtifact`. New configuration and documentation use the camelCase names.

`agent.reportProgress` is the only agent event copied into the shared issue conversation. Agents keep it short and user-facing; raw harness events remain separately retained as technical logs. The next run receives the shared conversation in its initial context and can refresh it through `conversation.get`. The authenticated owner can add messages from the issue detail window. Stage execution remains sequential per issue, so only the active lead agent writes agent messages at a given time.

An owner message is also an explicit resume signal. If the issue is not currently executing, Conveyor answers any open structured question with the message, clears recoverable workflow state labels, restores the current stage, and schedules a fresh attempt. Rejected, blocked, paused, waiting, needs-input, and needs-intervention states are recoverable this way, including post-merge stages when closure is correlated with Conveyor's own merged PR. Dependencies and concurrency remain enforced, so Conveyor reports whether the stage started or is queued. Manually closed, done, missing, inconsistent, offboarded, and roll-up parent issues are not restarted by conversation.

One dispatcher in the service enforces the grant again after the MCP server's filtering, validates the input schema, the actor and preconditions (an input `headSha` must equal the live change head, so an agent cannot act on a stale view), and journals every mutating call by run, tool and input hash before execution so a retried call returns the stored response. Read tools are always live. Legacy verifier agents receive a read/report-only subset even if their definition lists mutation tools. Agent-visible source guidance is supplied by the source plugin so instructions remain exact for GitHub without contaminating the generic engine.

Agents may use harness-native subagents. Only the lead reports to Conveyor or mutates the source. Cost and duration that the harness cannot attribute to subagents are assigned to the lead run; subagents appear with zero separately attributable cost.

## 14. Reliability and recovery

Every run has a durable ID, attempt number, lease, heartbeat, process metadata, log path, and persisted events.

- Stage advancement occurs only after the exit gate opens, its checkpoints and the context are durably recorded, and the source-label transition is confirmed (*legacy*: after exit-verifier success and configured lifecycle actions). Section 8 specifies the journal, idempotency keys, epochs and restart behaviour.
- A process crash or lost heartbeat marks the attempt interrupted and schedules a fresh attempt at the same stage with exponential backoff. Consecutive infrastructure failures use their own configurable limit, default five, then block with diagnostics.
- An intentional Conveyor/VPS shutdown interrupts and later resumes the attempt without consuming an infrastructure retry.
- Existing worktree changes are preserved.
- A harness session may be resumed after a question when it advertises `sessionResume`, but correctness never depends on conversational session recovery.
- Usage-limit detection records a waiting state and next retry time, then automatically retries the same configured runner with backoff and jitter. Its retry count is unlimited by default and never falls back to another runner.
- There is no fallback harness in v0.1.
- Source mutations use idempotency records so replay cannot duplicate children, comments, labels, or PRs.
- Merge intent and the managed PR identity are journaled before the merge call so a closing webhook race can always be correlated with the expected post-merge path, and `change.merge` observes an already merged change before acting.
- A pending task keeps its first-pending time, wake-up and deadline across restarts; a persisted wake-up makes the item schedulable again.
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

- A single horizontally scrolling Kanban row ordered as the built-in Backlog lane, exactly one column for every configured stage including the first stage, and the built-in Done lane.
- Backlog contains ordered, top-level, open issues carrying the base enrollment label that have not started and do not yet carry a stage label. Once execution starts, the card moves to its configured stage.
- Done contains every source-closed issue that retains any Conveyor label. It initially renders 20 cards and provides a server-rendered load-more control.
- GitHub's close reason is projected independently: `completed` renders as Completed; non-completion or absent close reasons render as Closed. Both remain in Done and require no attention.
- A separate needs-attention view contains only open enrolled issues with a missing, unknown, or conflicting stage label that are not valid untouched backlog items. Such issues never disappear from the UI and are not guessed into a stage.
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
- A live shared conversation containing owner messages, concise agent progress, and Conveyor script/action start and result messages; raw run events remain under Technical logs.

Each configured stage heading names its responsible agent and title. Deterministic script and source-action stages are identified as `Script`.

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
- `item_contexts`, `context_history`, `task_executions` and `stage_cursors` (task-chain execution state; `item_contexts` also holds the stage epoch)
- `ci_marks` and `advisory_ci_watches`
- `criterion_approvals`, `findings` and `finding_events`
- `conversation_messages`
- `artifacts` and `log_files`
- `usage_cost_entries`
- `web_sessions`

All workflow-changing writes are transactions. Migrations are numbered, automatic on startup, and backed up before applying a destructive migration. SQLite foreign keys and busy timeouts are enabled. A configurable online SQLite backup runs daily by default and retains seven copies.

Raw logs rotate and compress at a configurable size. V0.1 does not delete audit summaries, cost records, or raw logs unless an explicit retention policy is configured; the UI warns when configured data storage crosses its warning threshold.

## 19. Security assumptions

This is a trusted single-user VPS tool, not a hostile multi-tenant execution service.

- Codex receives automatic approvals and workspace-write access scoped to the issue worktree plus the minimal Git worktree administrative path required for local commits; the primary checkout's files remain outside writable scope.
- Reviewers receive read-only workspace access.
- Process environment is allowlisted per harness; web/session and source API credentials are never passed to agents or ordinary scripts. A deployment script receives only secrets explicitly allowlisted for that script.
- Agents receive no source-provider credentials: every Codex agent process starts from a sanitized environment (provider tokens and their enterprise variants, `GIT_ASKPASS`, `SSH_AUTH_SOCK`, `GH_CONFIG_DIR`, `GIT_CONFIG_GLOBAL`, every `CONVEYOR_*` variable and anything named like a token, secret, password or API key are removed) with a per-run `HOME` holding only a `.gitconfig` with the repository's `user.name` and `user.email`. Codex authenticates through `CODEX_HOME`, which keeps pointing at the real `~/.codex`.
- Repository paths are resolved and validated against configured absolute paths.
- Commands are argument arrays, not shell-concatenated strings.
- Logs redact configured secret patterns and environment values.
- MCP authorization is run-scoped and expires with the run.
- UI writes, source mutations, runner starts/stops, and merges are audited.

This limits accidental damage but is not a security boundary against malicious repository code. Isolation below lists the controls and their residual risks.

### Agent network egress

A repository may declare `agentEgress` (optional; without it agents get the sanitized environment only): `allowLoopbackMcp` (default `true`) and `httpsHosts` (default `[]`), exact lowercase DNS names only, with no wildcards, IP literals, CIDRs, ports, schemes, trailing dots or duplicates, and never `api.github.com` or `uploads.github.com`. A missing package host fails closed and is added through reviewed configuration, never opened dynamically. The allowlist governs the agent's sandbox, that is every command the agent runs and its children; the harness's own connection to its model API runs outside that sandbox through a separate authenticated proxy and is not reachable from agent commands.

Repositories that declare `agentEgress` run every Codex agent process (every `agent.run`, and legacy verifier checks) inside `bwrap --unshare-net --unshare-pid --die-with-parent --dev-bind / / --proc /proc` (the whole sandbox dies with bwrap; host processes are hidden); repositories without the block are unchanged (sanitized environment only). Steering runs are system-scoped (no repository) and are not sandboxed.

- `src/isolation/egress-proxy.ts`: a CONNECT-only proxy on a Unix socket. Only `CONNECT <exact allowed host>:443` is served; plain HTTP is 403, a missing or wrong `Proxy-Authorization` token is 407, IP-literal targets are 403, and DNS is resolved by the proxy, which refuses (403) any answer in loopback, private, link-local, CGNAT, unique-local, multicast or unspecified ranges and then dials the resolved address itself. Every CONNECT is evaluated independently, so every redirect hop is checked.
- `src/isolation/bridge.ts` runs inside the namespace: it listens on `127.0.0.1:<port>` for each forward, pipes each connection to the corresponding Unix socket, runs the wrapped command and mirrors its exit code and signals. `src/isolation/sandbox.ts` builds the bwrap argv and the proxy environment (`NO_PROXY` is empty, or `127.0.0.1` when the MCP forward exists).
- Two proxies per run live under `<artifacts>/<runId>/net/` and are closed when the run ends: the data plane (the repository's `httpsHosts`) for commands, and the control plane (the runner's `controlPlaneHosts`, default `chatgpt.com`, `api.openai.com`, `auth.openai.com`, protected by a random per-run token) for Codex itself. Codex's own `HTTPS_PROXY` is `http://conveyor:<token>@127.0.0.1:<port>`; commands it runs receive the data-plane proxy through `-c shell_environment_policy.exclude=[...]` and `-c shell_environment_policy.set={...}`, and `-c sandbox_workspace_write.network_access=true` lets them reach the loopback bridge (the namespace and the proxy are the enforcement, identical for read-only and workspace-write runs).
- With `allowLoopbackMcp`, the service serves `/internal/mcp` (only) on a Unix socket `<artifacts>/mcp.sock`; the bridge forwards the exact web port to it. No other host loopback service is visible in the namespace.
- Host path-based Unix sockets stay reachable through `--dev-bind / /` (abstract sockets are isolated by the network namespace). Mitigated: a private tmpfs over `/tmp` and `/run/user/<uid>` (user bus, ssh/gpg agents) and masking of `/run/docker.sock`; per-run sockets therefore live under `<artifacts>/<runId>/net/`, never `/tmp`, and workspaces under `/tmp` are not visible to sandboxed agents. Any other path socket the operator machine exposes (for example under `/var/lib` or a home directory) remains reachable and is outside this control.
- Residual risk: a process running as the same user can read the control-plane token from `/proc/<codex pid>/environ`, and Codex's own shell-policy handling is trusted to keep proxy variables out of commands. The token only authenticates a proxy that reaches the model hosts and dies with the run. The `shell_environment_policy` and `sandbox_workspace_write.network_access` keys follow Codex's documented configuration and were not exercised against a live Codex run; run `scripts/check-agent-egress.ts` and one canary agent run before relying on them.
- Residual risk: the sandbox is network and PID isolation only. `--dev-bind / /` leaves the host filesystem visible; confinement of file access remains Codex's own `workspace-write` or `read-only` sandbox.
- Residual risk: traffic to an allowed host is an opaque TLS tunnel. An agent, or a malicious dependency it installs, can send data to any allowed host (for example a package registry that accepts requests with arbitrary paths); the allowlist limits where, not what.
- Residual risk: a repository without `agentEgress` gets the sanitized environment but no network isolation (legacy behaviour until its configuration is migrated), steering runs are system-scoped and not sandboxed, and enforcement requires Linux with `bwrap`.
- Residual risk: the sandbox has not yet been exercised against a live Codex run; that live smoke run is a prerequisite of the canary (`docs/migration.md`).
- Operator verification: `bun scripts/check-agent-egress.ts <repository-id> --config <dir>` (real network; not part of `bun test`). It restores the repository's dependencies in the sandbox with an empty cache, requires `api.github.com` and direct IP connections to fail, and lists every host the proxy refused so the allowlist can be completed.

## 20. Definition of done for v0.1

V0.1 is complete when a configured GitHub issue can demonstrate this path after a service restart at any point:

1. Adding `conveyor` enrolls it, creates a clean worktree, and places it in the global backlog.
2. A configurable refinement agent creates verified acceptance criteria, labels, dependencies, and optional refined children.
3. A child or leaf progresses through arbitrary configured script/agent stages in a worktree.
4. Every stage runs its actions and then its deterministic exit gate; a failed gate returns actionable feedback to the correct stage within the configured retry and return limits.
5. A structured question pauses without occupying a runner and can be answered in the UI.
6. `change.ensure` opens one PR after implementation, required CI gates it, and a read-only reviewer records criterion approvals and findings at the current head; the review gate checks findings, approvals, the CI head and mergeability.
7. `change.merge` squash-merges only the reviewed head after the review gate passes.
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
6. Configurable task-chain stages, exit gates, feedback routes, scripts, and questions.
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

## 23. Distribution and operation

- **Release:** one Bun-compiled executable per supported platform (Linux x64; arm64 when its tests pass), embedding the runtime, dashboard and assets, result schemas, packaged defaults, the MCP server and the sandbox bridge (internal subcommands `__mcp` and `__bridge`). Releases are GitHub releases cut from `vX.Y.Z` tags with `checksums.txt` and `install.sh`; external tools (Git, GitHub CLI, bubblewrap, agent CLIs, the repositories' build tools, and an interpreter for each operator script) remain prerequisites that `conveyor doctor` reports.
- **Locations:** the installed releases (`<prefix>/versions/<version>`, `<prefix>/current`), the Conveyor home (configuration, credentials, state, logs, artifacts, worktrees, backups) and the managed repositories are independent. Upgrades never change configuration or credentials; uninstalling the service keeps the home and the releases.
- **Control:** the CLI reaches the running service through `<home>/run/control.sock`, usable only by the service account, and calls the same operations as the dashboard; it never edits the database behind the engine.
- **Accounts:** no default password; `conveyor init` seeds the first administrator only while no account exists; the session secret is generated once beside the database unless configured.
- **Logging:** service logs (stdout/stderr and `<logs>/conveyor.log`, JSON lines, rotated) carry repository, item, stage and run, and are redacted; run history stays in the database and run artifacts, pruned only by `settings.retention` and only for closed, done or offboarded items.
- **Drain, upgrade, rollback:** a drain stops admission while running work finishes. An upgrade stages and verifies a release, validates the configuration with it, drains, backs up the state, switches `<prefix>/current` and restarts under systemd, then verifies the new release; an upgrade requested by Conveyor's own stage does not wait, so its stage ends before the switch. A rollback returns to the previous recorded release and requires restoring the pre-upgrade backup when the database was migrated; an older release refuses a newer schema.
