# Migrating to the reference configuration

Conveyor ships a versioned reference configuration in `examples/config/` (providers, harnesses, agents, the `delivery` and `midgame-delivery` pipelines, and the agent instructions). The live service imports it at a pinned git commit; paths, secrets, repositories and scripts stay machine-local. Until the migration finishes, the legacy configuration keeps working through the compatibility compiler.

## What lives where

| Shipped (`examples/config/`, imported and pinned) | Machine-local (`examples/local/`, copied and edited) |
| --- | --- |
| `providers.yaml`: item/code/CI providers, shared labels, harnesses | `local.example.yaml`: `import:` pin, `settings` (paths, limits), `web` |
| `agents.yaml`: agents and their exact task grants | `repositories.example.yaml`: all five repositories (folders, `agentEgress`, deploy/verify script overrides) |
| `pipeline.yaml`: `delivery` and `midgame-delivery` | Stage scripts, for example `~/.config/conveyor-v2/stages/*.ts` |
| `instructions/{darya,kaveh,shirin,omid}.md` | |

`examples/config` holds no repositories or settings on purpose: the importer loads every YAML file under it, and a section may be defined once.

Import the reference like this (the example `local.example.yaml` has it):

```yaml
import:
  repository: /home/ubuntu/codes/conveyor-v2   # a git checkout
  ref: <commit-sha-or-tag>                      # the pin; read from git, never the working tree
  path: examples/config
```

Imported files are copied to `<settings.artifacts>/config-imports/<sha>/`. The configuration hash includes the pinned commit, so changing the pin changes the hash.

## Prerequisites (before any canary)

1. **Observe phase for each reconciling deploy script.** The reference marks the deploy of caravan, meal-planner, midgame and quesshi `recovery: reconcile`, as the design requires, but the current deploy scripts only implement `apply`. Add an `observe` phase to each before migrating that repository. The protocol is in [tasks.md](tasks.md#script-protocol): `observe` prints `{ "state": "already-applied", "operationId": ..., "result": <apply output> }`, `{ "state": "not-applied" }` or `{ "state": "indeterminate", "reason": "..." }`, and it must never change anything. After a restart the engine observes first and applies only when `not-applied`; `indeterminate` stops with `needs-intervention` rather than risk a duplicate deploy. Verify scripts are declared `replay-safe` and need nothing. Conveyor's own deploy is a no-op declared `replay-safe`, so the canary does not depend on this.
2. **Agent egress per repository.** For each repository run `bun scripts/check-agent-egress.ts <repository-id> --config <config-dir>`. It restores dependencies in the sandbox with an empty cache and only the repository's `agentEgress.httpsHosts`, proves the GitHub API and direct IPs are refused and lists every refused host so the allowlist can be completed. Needs the real network; not part of `bun test`.
3. **A live Codex smoke run inside the sandbox.** This has never been performed. Run one real Codex agent (any short task, for example refining a throwaway issue) with the sandbox and egress enforcement on, and confirm it reaches its model endpoint, reaches the run-scoped MCP socket, and cannot reach anything else. Do not canary before this passes.
4. `bun test` and `bunx tsc --noEmit` pass on the commit you will pin.

## 1. Shadow compare

Compile the current and the new configuration and read the differences before changing anything live:

```sh
bun run src/cli.ts check-config --config ~/.config/conveyor-v2 --compare /path/to/candidate-config
```

The candidate directory is a copy of `examples/config` plus a local file with settings and repositories (or the same `import:` block). The command prints, for each repository present in either side and for each stage, the task sequences side by side (current on the left), then a summary: `added`, `removed` and `changed` tasks, including `onFail` routes, `wait` timeouts and polls, `with` values, and stage `concurrency`/`retries`. It exits 0; reading the summary is the review. Expect: the legacy `ci` stage gone (CI is now part of implementation and review gates), enter/exit checks replaced by exit gates, and no AI verifier.

Repository ids are matched by name. A repository present on one side only is listed as such; rename it in the candidate if the id changed so the comparison is meaningful.

## 2. Canary on `conveyor` itself

Conveyor's own repository is the canary: its deploy is a replay-safe no-op, and a failure affects only the delivery of Conveyor.

1. The issues of `conveyor` were offboarded for this refactor. After the refactor merges, re-enrol them (add the `conveyor` enrolment label); until then nothing runs there.
2. Migrate **while idle**: no issue should be mid-stage. Check the board (nothing running, parked or waiting) and stop `conveyor.service` via the deploy-when-idle script or by hand.
3. Pin the live configuration to the merged commit: add the `import:` block (and `settings`/`repositories`) from the examples to `~/.config/conveyor-v2`, remove the legacy `pipelines`, `checks`, `runners`, `agents`, `sources` and `ci` sections that the import now provides, and keep a copy of the legacy files for rollback. Only `conveyor` gets the new pipeline in this step: keep the other four repositories on their legacy pipelines (a repository chooses its own `pipeline`) until step 4.
4. Run `check-config` against the live directory, then start the service.
5. Re-enrol one small issue and **watch one complete delivery**: refinement (criteria, labels), implementation (push, change, CI), review (findings and criterion approvals), merge, deploy, verify, cleanup. Read `check-config` output and the item's task history as you go. Required CI blocks if no CI is defined; reviews must record findings with `change.comment` before returning `changes-requested`.
6. When that delivery succeeds, re-enrol the remaining `conveyor` issues.

## Rollback

Rollback is a configuration change, not a code change:

- Pinned import: edit `import.ref` back to the previous commit (or tag) and restart. The hash changes and the previous reference is materialised again.
- Legacy files: restore the backed-up legacy files (and remove the `import:` block) and restart. Legacy stages keep working through the compatibility compiler.

A parked item is never resumed against an incompatible plan (D4: the context carries the `configHash`). An item parked under a different compiled plan (which a pin change or rollback causes for its stages) is restarted explicitly at its stage, not resumed. Check the board for parked or waiting items after a rollback and restart the affected stages from the board. Items whose stage plan is unchanged resume normally. Work already pushed or merged is untouched by a rollback.

Keep the legacy files and the previous pin until one complete delivery has succeeded in every repository.

## 3. The remaining four repositories

For each of caravan, meal-planner, midgame and quesshi, one at a time and while idle:

1. Its deploy script has an `observe` phase (prerequisite 1) and `scripts/check-agent-egress.ts` passed for it.
2. Point its `pipeline` at `delivery` (`midgame-delivery` for midgame) with the `repositories.example.yaml` entry (overrides for the deploy and verify script paths). caravan and meal-planner have `ci: { mode: disabled }` because they have no workflows; switch a repository to `required` only once it has a CI workflow.
3. Run the shadow compare for it, restart, and watch one complete delivery before moving on. Keep the rollback until it succeeds.

## After the migration

- Delete the legacy adapter paths (`legacy.*` tasks, the compatibility translator, the old `run`/`enterCheck`/`exitCheck` stage shape) and the Mitra agent, `checks:` section and `agent.verify` once all five repositories are migrated.
- Close #17 (non-blocking CI stage) in favour of `ci.mode: advisory` with `when: ci.required`.
- Re-scope #10 to the provider registry only; the task registry is done.
- #11 and #13 have open pull requests that need rebasing onto the merged work.
- Re-enrol the offboarded `conveyor` issues if not done in step 2.
