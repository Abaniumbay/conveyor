# Configuration

Conveyor reads one entrypoint, `conveyor.yaml` (by default `<home>/config/conveyor.yaml`). It can
hold everything, or place content in other files with tags written where the content belongs. The
entrypoint therefore shows the whole shape of the configuration and where every section comes from.
Each value has exactly one source.

```yaml
# conveyor.yaml
settings:
  runners: 4

web:
  listen: 127.0.0.1:7788
  publicUrl: https://conveyor.example.com

providers: !include providers.yaml
harnesses: !include builtin:harnesses.yaml
agents: !include_dir_merge_named agents/
pipelines: !include builtin:pipelines.yaml
repositories: !include_dir_named repositories/
```

```yaml
# repositories/meal-planner.yaml: the file name is the repository id; no wrapper section
items: github
code: github
ci: { mode: disabled }
address: owner/meal-planner
folder: ~/codes/meal-planner
pipeline: delivery
agentEgress: { allowLoopbackMcp: true, httpsHosts: [registry.npmjs.org] }
```

`conveyor init` writes a starter entrypoint that includes the packaged defaults. `conveyor config
check` validates the configuration and prints every repository's compiled plan. `conveyor config
show` prints the effective configuration with secrets redacted.

## Tags

| Tag | Result |
| --- | --- |
| `!include <file>` | The file's content becomes this value. |
| `!include_dir_named <dir>` | A map: file name without extension → that file's content. |
| `!include_dir_merge_named <dir>` | The maps of every file in the directory merged into one; a key defined twice is an error. |
| `!secret <key>` | The value of `<key>` in `secrets.yaml` beside the entrypoint. |
| `!include builtin:<file>` | A packaged default embedded in the executable (`conveyor config builtin` lists them). |

- Paths in tags resolve against the file that contains the tag. Paths inside an included file
  (instructions, scripts, folders, settings paths) also resolve against that file. `~/` means the
  service account's home.
- Includes nest; a cycle is an error that prints the include chain.
- Directory tags read only `*.yaml` and `*.yml` files directly in the directory (not subdirectories),
  in sorted order.
- Every error names the file that defined the value and the key path inside it, for example
  `repositories/meal-planner.yaml: pipeline references unknown pipeline "delivry"`.

## Secrets

Keep credentials out of Git, including out of a private configuration repository.
`secrets.yaml` sits beside the entrypoint, and `conveyor init` adds it to `.gitignore`:

```yaml
# secrets.yaml (never committed)
github_webhook_secret: "..."
session_secret: "..."
```

```yaml
# conveyor.yaml
providers:
  items:
    github: { type: github, webhookSecret: !secret github_webhook_secret, labels: { ... } }
web:
  sessionSecret: !secret session_secret     # optional: Conveyor generates and keeps one otherwise
  push: { publicKey: "...", privateKey: !secret vapid_private_key, subject: mailto:ops@example.com }
```

A missing key is a validation error that names the key and never prints a secret value. Values
from `!secret` are redacted from `config show`, the stored configuration snapshot, service logs and
diagnostics exports.

If `secrets.yaml` is malformed, Conveyor reports only its file name and YAML parser position, for
example `cannot parse secrets.yaml: invalid YAML at line 2, column 1`. It never includes a secret
value, source excerpt, or parser token from that file. Malformed ordinary configuration YAML,
including an entrypoint or `!include` file, keeps the YAML parser's detailed diagnostic to help
troubleshoot configuration syntax.

The environment variables `CONVEYOR_GITHUB_WEBHOOK_SECRET`, `CONVEYOR_SESSION_SECRET` and
`CONVEYOR_VAPID_*` still work as fallbacks.

## Packaged defaults

`builtin:` files are the reference configuration in [`examples/config`](../examples/config), embedded
in each release:

- `providers.yaml`, `harnesses.yaml`, `agents.yaml` and `pipelines.yaml`, each holding one section's
  value;
- `instructions/*.md`.

They need no clone of the Conveyor repository. A section either includes a packaged default or is
your own; defaults are not merged with overrides. To change a default, copy it into your
configuration (`conveyor config builtin builtin:agents.yaml > agents.yaml`) and include your copy.
Repositories still change single tasks of a pipeline through `overrides` (see the README).

When included, the packaged files are written to `<home>/state/builtin/<digest>/`, because agents
read their instruction files by path.

## Defaults that come from the home

With a Conveyor home, unset state paths default to the home layout:

| Setting | Default |
| --- | --- |
| `settings.database` | `<home>/state/conveyor.sqlite` |
| `settings.logs` | `<home>/logs` |
| `settings.workspaces` | `<home>/worktrees` |
| `settings.artifacts` | `<home>/artifacts` |
| `web.listen` | `127.0.0.1:7788` |

The dashboard's external address is `web.publicUrl`, separate from the listen address. A reverse
proxy provides HTTPS.

## Logging and retention

```yaml
settings:
  logging:
    level: info             # debug | info | warn | error
    format: text            # stdout/stderr; the file is always JSON lines
    maxFileMegabytes: 10    # <logs>/conveyor.log rotates when it would exceed this
    keepFiles: 5            # conveyor.log.1 ... .5; older files are deleted
  retention:
    runHistory: 90d         # run events (agent transcripts, tool calls); default unlimited
    artifacts: 30d          # per-run artifact directories; default unlimited
```

The retention settings apply to run events and non-home per-run artifacts of finished runs whose
items are closed, done or offboarded, and to finished steering runs. Independently of those settings,
every terminal run's private `home` directory is reclaimed, including runs of open, parked and
stopped items; a running run's home is never selected. Recorded results, events and artifacts outside
that private home remain subject to the configured retention policy. The service checks at start and
daily; `conveyor cleanup` applies the same operations on demand. Before deleting a selected home,
cleanup restores the service owner's read, write and execute access to its real directories so that
restricted caches and temporary directories can be removed. Symbolic links, including a link used as
the home itself, are removed as links and their targets are never inspected or changed. A dry run
does not change permissions or remove homes. If a selected home still cannot be reclaimed, Conveyor
warns once with its run ID and failure reason; the receipt survives service restarts, while a newly
failing home still produces its own warning.

## Events

Every change Conveyor makes is recorded in its event log ([events.md](events.md) lists them). The
dashboard updates live from it, `conveyor events` prints it, and event sinks deliver it outside
Conveyor, for example to an analyzer or a log shipper.

```yaml
settings:
  events:
    retention: 30d          # how long the log keeps events (default 30d); cleanup prunes older ones
    sinks:                  # default none
      - { type: jsonl, path: /var/log/conveyor/events.jsonl }
    fallback:               # how long a wait for a webhook event sleeps when none comes
      default: 15m          # any event wait without its own value
      ci: 5m                # waiting for CI (ci.passed, ci.settled, advisory CI watches)
      change: 10m           # waiting for a pull request (change.mergeable)
      dependencies: 30m     # waiting for blockers (item.dependenciesMet)
    reconcileInterval: 30m  # the light safety-net reconcile while webhooks are healthy
    fullReconcileInterval: 24h  # the full reconcile while webhooks are healthy
```

A task that waits for something GitHub reports by webhook (CI finishing, a new pull request
head, a blocker closing) names those events. While the repository's webhooks are healthy, the task
sleeps until one of them arrives and runs again within seconds; when none comes, it looks again
after its fallback. A lost delivery therefore delays a wait by at most its fallback and never
changes its result. Waits that GitHub announces no event for, such as a pull request's mergeability
being computed, keep their `wait.poll` interval.

Webhooks count as healthy when Conveyor manages the repository's webhook (`autoConfigureWebhook`
with a `web.publicUrl`), GitHub reports it active, and its last delivery succeeded or none was made
yet. Conveyor checks at start and hourly; any delivery received counts as healthy at once. While a
repository's webhooks are unhealthy, or it uses polling, every wait polls at its `wait.poll`
interval as before.

While a repository's webhooks are healthy, its deliveries keep Conveyor current and the periodic
reconcile is only a safety net. Every `settings.events.reconcileInterval` it does a light pass: it
lists only the issues changed since the last read and reads relationships, pull request heads and
CI for those alone. Every `settings.events.fullReconcileInterval`, and at start, it does a full
pass: every issue, every enrolled item's provenance and author permissions, and the repository's
visibility. An unchanged issue's sub-issues and blockers are reused for six hours instead of one.
While a repository's webhooks are unhealthy, every periodic reconcile is a full pass every
`settings.reconcileInterval`.

GitHub sends no event for some changes, such as a collaborator's permission or a repository's
visibility. A superuser can read one repository afresh at once with **Sync now** on its page, in
the Setup section: a full pass that also forgets the cached relationships and re-checks the
webhook.

Deliveries GitHub could not make, for example while Conveyor was restarting, are asked for again:
once Conveyor listens after a start, and hourly, it lists the webhook's recent deliveries and asks
GitHub to send again, at most 50 at a time, those of the last day that failed and never arrived.
This needs the same permission as configuring the webhook; without it Conveyor warns once and
relies on the safety-net reconcile.

A `jsonl` sink appends each event as one JSON line, rotated with the `settings.logging` size rules.
Each sink keeps its own position in the database: it receives every event at least once and in
order, resumes after a restart where it stopped, and retries a failed delivery with backoff (up to a
minute) without slowing Conveyor down. A new sink starts with the events the log still holds. When
retention removes events a sink has not received, the sink logs how many it missed and continues.
Event payloads carry identifiers and states, never secrets or user-written text.

## Operator scripts

`script.run` tasks, legacy script stages and check scripts run
`<interpreter> <script>`. `interpreter` is an argv prefix and defaults to `[bun, run]`, so
TypeScript and JavaScript scripts need Bun installed on the machine, separately from the Conveyor
executable:

```yaml
- { id: deployScript, task: script.run, with: { script: ./stages/deploy.py, interpreter: [python3], recovery: reconcile } }
- { id: verifyScript, task: script.run, with: { script: ./stages/verify, interpreter: [], recovery: replay-safe } }   # executed directly
```

The script protocol (JSON request on stdin, JSON result on stdout, and `observe` for reconciling
scripts) is the same for every interpreter; see [tasks.md](tasks.md#script-protocol).
`conveyor doctor` checks that every interpreter the configuration uses is installed.

## Refinement outputs (issue type, fields, Refinement section)

A repository may let refinement fill the GitHub issue page beyond the criteria:

```yaml
repositories:
  conveyor:
    refinement:
      fields: [Effort, Priority]                                  # organization issue fields item.setFields may write
      require: { type: true, fields: [Effort], section: true }   # enforced by the refinement gate item.refinementComplete
```

`item.setType` accepts only a type the repository owner's organization defines, and `item.setFields`
only the fields listed in `fields` (single-select values must be one of the field's options, dates
use `YYYY-MM-DD`). `item.setRefinement` writes the managed `## Refinement` section of the body. The
gate names every required output that is missing and returns the item to refinement; it does not
require a type or field the owner does not define, nor one the credentials cannot read. Dates, the
work branch and the pull request are Conveyor's lifecycle facts and are not written by refinement.
`conveyor doctor` checks the credentials.

## Configuration directories (deprecated)

`--config <directory>`, which merged every YAML file found recursively, still loads with a deprecation
warning and keeps its v0.1 defaults (state under `<directory>/data`, port 4300). So does a
Git-pinned `import`. Convert either with:

```sh
conveyor config migrate --from <old-directory> --to <new-config-directory>
```

The command writes a tag-based `conveyor.yaml`: one file per section, and one file per repository
under `repositories/`. It keeps `!secret` references (the values move to the new git-ignored
`secrets.yaml`), copies instruction files into the new directory, and keeps script, folder
and state paths as they are, writing the effective settings and listen address out explicitly. It
then loads both configurations and reports whether the compiled plans and the effective
configuration are identical; it exits 1 if they are not. `conveyor config compare <old> <new>` makes
the same plan comparison later.

## Validating

```sh
conveyor config check
conveyor config compare /path/to/other/conveyor.yaml
```

`config check` prints the configuration hash and then, for every repository that compiles, the
expanded plan of each stage: the `actions` and `exit-gate` task instances in order with their
implicit loads (`(load item)`, `(load change)`...), `with` values, `wait` timeout and poll and the
effective `onFail` (marked `(default)` when not configured). A manually approved exit gate is
marked `[check, manual approval]`; ordinary checks remain `[check]`. Legacy stages appear as their
`legacy.*` tasks. An invalid task, instance id, route or dataflow is reported with its file and path
before the service can start. `config compare` prints two configurations' compiled plans side by
side, marking any manual exit gate and reporting a manual approval setting change in its summary;
it exits 1 when the plans differ, including when only that setting differs.

## Reference

The canonical shape names the three provider roles, the harnesses, and gives every stage `actions` and an `exit-gate`. This is the shape of the packaged defaults in [`examples/config`](../examples/config) (see [tasks.md](tasks.md) for every task). Written as one `conveyor.yaml`:

```yaml
settings:
  runners: 4
  database: /srv/conveyor/state/conveyor.sqlite
  logs: /srv/conveyor/state/logs
  workspaces: /srv/conveyor/state/worktrees
  artifacts: /srv/conveyor/state/artifacts
  reconcileInterval: 5m
  maxReturns: 5
  agentRunTokenWarning: 15000000   # warn (never stop) when one agent run uses more input tokens
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
  listen: 127.0.0.1:7788

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
          noSplit: conveyor:no-split
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
  claude-code:
    type: claude-code
    command: claude          # configDir: defaults to ~/.claude, the service user's login
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
            agent.askQuestion, item.comment, item.setCriteria, item.setTitle, item.setSystemLabels, item.setType, item.setFields, item.setRefinement,
            item.setParent, item.setDependencies, item.createChild]
  implementer:
    name: Implementer
    title: Software Engineer
    harness: codex
    effort: high
    instructions: ./instructions/implementer.md
    access: workspace-write
    network: true                     # web search, and network for installs and builds
    writableRoots: [~/.bun/install/cache, ~/.npm]   # package caches; missing ones are skipped
    env: { npm_config_cache: ~/.npm, BUN_INSTALL_CACHE_DIR: ~/.bun/install/cache }   # point tools at them
    codexConfig: { model_auto_compact_token_limit: 80000 }   # extra Codex settings (-c key=value)
    mcpServers:                       # tools beside Conveyor's own, e.g. a code index
      serena:
        command: serena
        args: [start-mcp-server, --project, "{workspace}", --context=codex]
        env: { SERENA_HOME: ~/.serena }
        startupTimeoutSec: 60
        enabledTools: [find_symbol, find_referencing_symbols, get_symbols_overview]  # it runs outside the sandbox
        gitExclude: [.serena/]         # files it writes in the worktree; never committed
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
        description: "Turns an item into a clear, testable plan."   # optional: shown in the stage's dashboard dialog
        icon: "🧭"                                                  # optional: an emoji beside the stage's name
        concurrency: 3
        retries: 2
        actions:
          - { id: refine, task: agent.run, with: { agent: refiner } }
        exit-gate:
          - { id: criteria, task: item.criteriaDefined }
          - { id: labels, task: item.labelsValid }
          - { id: plan, task: breakdown.planComplete }
          - id: dependencies
            task: item.dependenciesMet
            wait: { timeout: unlimited, poll: 5m }
      - id: refinement-review
        actions:
          - { id: reviewPlan, task: agent.run, with: { agent: planReviewer } }
        exit-gate:
          - { id: reviewed, task: breakdown.reviewed, onFail: { return: refinement } }
      - id: work-breakdown
        childrenStartAt: next
        actions:
          - { id: createChildren, task: agent.run, with: { agent: childCreator } }
        exit-gate:
          - { id: complete, task: breakdown.complete, onFail: { return: refinement } }
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
          - { id: ciSettled, task: ci.settled, wait: { timeout: 3h, poll: 1m }, onFail: { stop: blocked } }
          - { id: review, task: agent.run, with: { agent: reviewer } }   # or agents: [first, backup]
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
    extraTrustedLogins: [review-bot]
    agentEgress:
      allowLoopbackMcp: true
      httpsHosts: [registry.npmjs.org]
    overrides:
      stages:
        deploy:
          actions:
            deployScript: { with: { script: /srv/conveyor/stages/deploy-example.ts, recovery: reconcile } }
```

Native review findings are trusted only when GitHub reports that the author has `write`,
`maintain`, or `admin` permission for that repository. `extraTrustedLogins` adds named accounts,
such as an approved review bot (GitHub App bot logins use the `name[bot]` form), and login
matching is case-insensitive. `read`, `triage`, no access, missing authors, and omitted logins
are not trusted. If GitHub cannot determine an author's permission, Conveyor retries native
review import and the review gate does not pass on an incomplete trust check.

`labels.metadata.noSplit` is a per-item metadata label that keeps refinement to one item. It defaults to `<labels.enrollment>:no-split`, so existing configurations continue to load unchanged; set it explicitly when the label name should differ from the enrollment prefix. Conveyor never adds, removes, or inherits this label. Adding it neither enrolls an issue nor changes its stage or state, and it remains present through Conveyor's workflow-label updates. Removing it takes effect on the next refinement run. While it is present, `item.createChild` refuses before changing the source issue, relationships, or dependencies; refine the whole scope instead, or report `needs-input` with a concrete reason when that is impossible. Existing children remain unchanged, and a child can be kept whole only by carrying the label itself. The dashboard marks labelled items as “No split”.

Task entries take `id`, `task`, `with`, `wait`, `onFail` and `when`. `id` defaults to the task name when it occurs once in the list and is required for duplicates; overrides, execution records, script results and idempotency keys use the instance id. `when` is a guard from a closed vocabulary (`ci.enabled`, `ci.required`, `ci.advisory`) evaluated at load time from the repository's CI mode; there are no expressions, variables or loops. `wait` is `{ timeout, poll }` (`timeout: unlimited` never expires; the default comes from the task, else `settings.taskDefaults.wait`). A repository changes a task without copying the pipeline through `overrides.stages.<stage>.<actions|exit-gate>.<instance id>` (`with`, `wait`, `onFail`); naming something that does not exist is an error. `settings.maxReturns` (default 5) bounds `return` loops between stages. `agent.run` takes `agent: <id>` or `agents: [<id>, ...]` in order of preference: when an agent's harness cannot run (a usage limit, a login failure, a crash), the next one takes the same step and the item's conversation says so; a result the agent returned, of any status, is never retried on another agent. An answered question goes back to the agent that asked it first.

### Manual exit-gate approval

Set `manual: true` on a named **native** `exit-gate` task to require a board approval after that task's automatic check passes. `manual` is invalid on an action and is not available on legacy stages. For example, this keeps the normal CI result as a prerequisite while adding a human decision:

```yaml
exit-gate:
  - { id: ciGate, task: ci.passed, manual: true }
```

On the board, a signed-in superuser can also require or remove an item-specific approval for a current or future native exit gate. Repository configuration and the item choice combine with OR semantics: removing the item choice never removes a configured requirement. The board labels the source of a waiting requirement and offers the approval button only to superusers; the action is CSRF protected. An approval records the account and time in the item history, then wakes the item to re-evaluate the gate without repeating its completed actions. It is valid only for that item, gate, and visit to the stage: a retry, return, or plan restart needs a fresh approval. Removing a requirement before the gate advances takes effect immediately.

Agents list their exact grants in `tasks:`. Verifier agents and the `checks:` section are not part of the native shape.

### Merge recovery

The default merge action observes the live pull request before merging. If review or required CI
belongs to an older head, or the code host reports a changed head, merge conflict, or outdated
base during the merge attempt, Conveyor returns the item to `implementation` with the repair
reason. That uses the normal bounded `settings.maxReturns` route: the implementer updates and
publishes the branch, then required CI and every non-manual criterion approval run again for the
new head before a fresh review can pass. A stale checkpoint or approval therefore cannot
authorize a merge. A pull request merged elsewhere still passes idempotently; a closed pull
request, permission or branch-protection refusal stops with its distinct reason, while a
transient code-host error uses infrastructure retry handling.

### Legacy configuration (deprecated, still supported)

Existing configurations keep loading. A stage with `run: { agent | runner + script | sourceAction }`, `enterCheck`, `exitCheck`, `feedbackCycles`, `failurePolicies`, `failureState` and `afterSuccess`, together with the `checks:` section (a deterministic script plus an AI verifier agent), `sources`, `codeHosts`, `runners`, `workspaceAccess` and a top-level `labels`, is compiled by the compatibility compiler into a task plan (`legacy.produce`, `legacy.enterCheck`, `legacy.exitCheck`, `legacy.afterSuccess`, `legacy.succeeded`) with the same behaviour as before and runs through the same durable executor. A legacy stage cannot be mixed with `actions` / `exit-gate` in one stage, and a pipeline with legacy stages still needs `successStatuses` and `failureStatuses`. Legacy `process` stage scripts have no recovery mode, so they stay behind the legacy adapter until each is classified `replay-safe` or `reconcile`. The legacy shape and the AI verifier will be removed once every repository is migrated; do not write new configuration in it.

### Canonical role names and agent settings

An agent's `network: true` turns on live web search. For a `workspace-write` agent it also gives the agent's own commands the network, so it can install dependencies and run the repository's checks before pushing. Codex's `read-only` mode has no network for commands, so a read-only agent gets web search only. A `workspace-write` agent can always write its worktree's git metadata, which a linked worktree keeps under the main repository's `.git`, outside the sandbox. `writableRoots` (absolute or `~/` paths) adds directories outside the worktree, typically package caches; the ones that do not exist on the machine are skipped.

A Claude Code agent runs inside bubblewrap with the whole filesystem read-only, the service's secrets hidden and `/dev/null` over the Docker and session-bus sockets. With `access: workspace-write` it also gets writable binds for its worktree, the worktree's git metadata and its `writableRoots`, plus the Edit and Write tools in `acceptEdits` mode, which accepts edits inside the worktree and refuses the rest; such an agent needs `network: true`, because the Claude CLI's own API calls need the network, so its commands cannot be kept off it. `network: true` also gives a Claude Code agent WebFetch and WebSearch.

An agent run does not see the service account's home: `HOME` is a directory of its own, empty apart from a minimal `.gitconfig`. Toolchains find their package caches through `HOME`, so on their own they would start every run with none and download everything again. `env` sets environment variables for the agent's run, and is how a toolchain is pointed at a shared cache listed in `writableRoots`: for example `NUGET_PACKAGES: ~/.nuget/packages`, `PUB_CACHE: ~/.pub-cache`, `GRADLE_USER_HOME: ~/.gradle` or `npm_config_cache: ~/.npm`. A `~/` value is expanded to the service account's home. The variables pass through the same filter as inherited ones, so a name that looks like a credential (`*_TOKEN`, `*_SECRET`, `GH_*` and the like) never reaches the agent.

A `workspace-write` Codex run can write its own `HOME`, and gets a temporary directory of its own as `TMPDIR`, which Conveyor deletes when the run ends. It is created under the service's temporary directory, so set `TMPDIR` in the service's environment to keep agent scratch on a disk of your choice; on many systems the default `/tmp` is held in memory. A Claude Code agent already has a private `/tmp` that disappears with the run.

`codexConfig` passes extra Codex settings as `-c key=value`, for example `model_auto_compact_token_limit` to compact a long session's context before it grows expensive. Keys Conveyor derives from the agent's other fields (`sandbox_mode`, `sandbox_workspace_write.*`, `mcp_servers.*`, `model_reasoning_effort`, `web_search`, `approvals_reviewer`) are refused. `mcpServers` gives the agent MCP servers beside Conveyor's own, such as a code index that answers symbol and reference queries instead of whole-file reads. `{workspace}` in a server's `args` becomes the run's worktree, `~/` in `env` values is expanded, and the servers are optional: one that fails to start does not fail the run. A server runs outside the agent's sandbox, so `enabledTools` should limit it to what the agent's access allows; for a read-only agent, lookups only. `gitExclude` lists files the server writes inside the worktree; Conveyor adds them to the repository's local git exclude before the agent runs, so they are never committed and never make a deploy see uncommitted changes. `codexConfig` is Codex-only; `mcpServers` works on Codex and Claude Code (whose allowed tools become `mcp__<server>__<tool>`).

The canonical configuration names the three provider roles and the harnesses: `providers.items` (issue trackers), `providers.code`, `providers.ci`, `harnesses`, agent `harness` and `access`, and repository `items` and `code`. The loader translates them to the older names (`sources`, `codeHosts`, `ci`, `runners`, `runner`, `workspaceAccess`, `source`, `codeHost`), which keep working. `labels` may sit on the item providers (all of them must carry an identical block, which a YAML alias gives you) or at the top level. Using the old and the new name for the same thing is an error, and equivalent documents produce the same configuration hash.

The packaged defaults replace the Git-pinned `import` of earlier versions, which still loads with a deprecation warning; `conveyor config migrate` inlines it.

### CI providers

CI is a role of its own. Select a named provider and a mode on a repository, or write `ci: <provider>` (mode `required`) or omit it to use the source's native CI provider (GitHub Actions for GitHub):

```yaml
providers:
  ci:
    actions:
      type: github-actions
      triggers:
      - label: run-web-e2e
        workflow: web-e2e.yml
        check: Headless Chrome smoke test
      - label: run-android-e2e
        workflow: android-e2e.yml
        check: Android emulator smoke
      - label: run-full-suite
        workflow: full-suite.yml
        check: Full suite
        replaces: [run-web-e2e, run-android-e2e]

repositories:
  example:
    ci: { provider: actions, mode: required, ignoreChecks: [Optional lint] }
```

`mode` is one of:

- **`required`** (the default): the implementation stage starts CI (`ci.start`) and its exit gate requires `ci.defined` (a missing or unprovable CI definition stops as `blocked`; it never passes silently) and `ci.passed` for every reported check of the current head except `ignoreChecks`. A red run returns to the implementation actions with the focused log; a cancelled run is rerun once; checks that have not registered are awaited for the settle window. The review gate also requires the head to be unchanged since CI passed (`change.headUnchanged`), and merge refuses a head other than the one CI passed for.
- **`advisory`**: only `ci.start` runs; the stage advances without waiting. CI start is announced once, and a durable watch per (repository, item, head commit) is polled by the service outside the stage, without a runner permit. It reports one final pass, failure with focused logs, or timeout (default 3 hours) to the item's conversation, survives a restart, is superseded by a newer head (whose older result is never posted), and never routes, stops or reopens the item.
- **`disabled`**: tasks guarded by `ci.enabled`, `ci.required` or `ci.advisory` are left out of the plan. The default review settlement action remains: it observes checks when the repository still runs them, but never makes their result a pass requirement.

Every default review starts with `ci.settled`. It waits for the current change head's checks to register and leave queued or running state, then starts the reviewer whether the settled result passed or failed. The wait is persisted, shown on the board with its head, unfinished checks, next poll, and deadline, and follows a newer head if one arrives. It uses the same registration settle window as `ci.passed`; if no applicable checks appear by that window's end, review proceeds under the repository's existing mode policy. Its finite timeout stops the item as blocked with the head and checks still unfinished.

Timing is task configuration (`ci.passed` `with: { settleSeconds, logLines }`, `ci.settled` `with: { settleSeconds }`, and `wait`, overridable per repository by instance id). Legacy pipelines keep the `ci.await` source action (`with: { settleSeconds, pollSeconds, timeoutMinutes }`) and `pullRequest.awaitChecks` with `with.triggers`; both are deprecated, and a stage cannot define triggers when its selected provider already declares them.
