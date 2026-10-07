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

Retention applies only to finished runs of items that are closed, done or offboarded, and to
finished steering runs. Open items, including parked and stopped ones, keep everything they may need
to resume. The service applies the policy at start and daily; `conveyor cleanup` applies it on
demand.

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
effective `onFail` (marked `(default)` when not configured). Legacy stages appear as their
`legacy.*` tasks. An invalid task, instance id, route or dataflow is reported with its file and path
before the service can start. `config compare` prints two configurations' compiled plans side by
side, with a summary of added, removed and changed tasks, routes and waits, and exits 1 when they
differ.

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
    agentEgress:
      allowLoopbackMcp: true
      httpsHosts: [registry.npmjs.org]
    overrides:
      stages:
        deploy:
          actions:
            deployScript: { with: { script: /srv/conveyor/stages/deploy-example.ts, recovery: reconcile } }
```

Task entries take `id`, `task`, `with`, `wait`, `onFail` and `when`. `id` defaults to the task name when it occurs once in the list and is required for duplicates; overrides, execution records, script results and idempotency keys use the instance id. `when` is a guard from a closed vocabulary (`ci.enabled`, `ci.required`, `ci.advisory`) evaluated at load time from the repository's CI mode; there are no expressions, variables or loops. `wait` is `{ timeout, poll }` (`timeout: unlimited` never expires; the default comes from the task, else `settings.taskDefaults.wait`). A repository changes a task without copying the pipeline through `overrides.stages.<stage>.<actions|exit-gate>.<instance id>` (`with`, `wait`, `onFail`); naming something that does not exist is an error. `settings.maxReturns` (default 5) bounds `return` loops between stages. `agent.run` takes `agent: <id>` or `agents: [<id>, ...]` in order of preference: when an agent's harness cannot run (a usage limit, a login failure, a crash), the next one takes the same step and the item's conversation says so; a result the agent returned, of any status, is never retried on another agent. An answered question goes back to the agent that asked it first.

Agents list their exact grants in `tasks:`. Verifier agents and the `checks:` section are not part of the native shape.

### Legacy configuration (deprecated, still supported)

Existing configurations keep loading. A stage with `run: { agent | runner + script | sourceAction }`, `enterCheck`, `exitCheck`, `feedbackCycles`, `failurePolicies`, `failureState` and `afterSuccess`, together with the `checks:` section (a deterministic script plus an AI verifier agent), `sources`, `codeHosts`, `runners`, `workspaceAccess` and a top-level `labels`, is compiled by the compatibility compiler into a task plan (`legacy.produce`, `legacy.enterCheck`, `legacy.exitCheck`, `legacy.afterSuccess`, `legacy.succeeded`) with the same behaviour as before and runs through the same durable executor. A legacy stage cannot be mixed with `actions` / `exit-gate` in one stage, and a pipeline with legacy stages still needs `successStatuses` and `failureStatuses`. Legacy `process` stage scripts have no recovery mode, so they stay behind the legacy adapter until each is classified `replay-safe` or `reconcile`. The legacy shape and the AI verifier will be removed once every repository is migrated; do not write new configuration in it.

### Canonical role names and agent settings

An agent's `network: true` turns on live web search. For a `workspace-write` agent it also gives the agent's own commands the network, so it can install dependencies and run the repository's checks before pushing. Codex's `read-only` mode has no network for commands, so a read-only agent gets web search only. A `workspace-write` agent can always write its worktree's git metadata, which a linked worktree keeps under the main repository's `.git`, outside the sandbox. `writableRoots` (absolute or `~/` paths) adds directories outside the worktree, typically package caches; the ones that do not exist on the machine are skipped.

A Claude Code agent runs inside bubblewrap with the whole filesystem read-only, the service's secrets hidden and `/dev/null` over the Docker and session-bus sockets. With `access: workspace-write` it also gets writable binds for its worktree, the worktree's git metadata and its `writableRoots`, plus the Edit and Write tools in `acceptEdits` mode, which accepts edits inside the worktree and refuses the rest; such an agent needs `network: true`, because the Claude CLI's own API calls need the network, so its commands cannot be kept off it. `network: true` also gives a Claude Code agent WebFetch and WebSearch.

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
- **`disabled`**: tasks guarded by `ci.enabled`, `ci.required` or `ci.advisory` are left out of the plan and no CI provider is needed.

Timing is task configuration (`ci.passed` `with: { settleSeconds, logLines }` and `wait`, overridable per repository by instance id). Legacy pipelines keep the `ci.await` source action (`with: { settleSeconds, pollSeconds, timeoutMinutes }`) and `pullRequest.awaitChecks` with `with.triggers`; both are deprecated, and a stage cannot define triggers when its selected provider already declares them.
