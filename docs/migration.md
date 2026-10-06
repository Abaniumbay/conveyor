# Migrating

## Moving to a release installation

This moves a server that runs Conveyor from a source checkout onto the released executable. On such
a server, `bun run src/cli.ts serve --config <directory>` is started by a systemd unit with
`CONVEYOR_*` variables. The examples use the reference server's paths: account `ubuntu`, checkout
`~/codes/conveyor-v2`, configuration directory `~/.config/conveyor-v2`, data under
`~/.local/share/conveyor-v2`. Nothing in the old locations is changed or deleted, so going back is
always possible.

This release adds no database migration, so the old checkout can still run on the same database.

1. **Install the release** as `ubuntu`, which leaves the checkout alone:

   ```sh
   curl -fsSLO https://github.com/Abaniumbay/conveyor/releases/download/v0.2.0/install.sh
   sh install.sh --version v0.2.0
   ```

2. **Convert the configuration** into the new home:

   ```sh
   conveyor config migrate --from ~/.config/conveyor-v2 --to ~/.conveyor/config
   ```

   It must report identical compiled plans and an identical effective configuration. The new
   `conveyor.yaml` writes out the old database, logs, workspaces and artifacts paths and the listen
   address, so the service keeps its data and its port. The agent instruction files are copied into
   `~/.conveyor/config/instructions/`, and the pinned `import` is inlined. Stage scripts keep their
   absolute paths under `~/.config/conveyor-v2/stages/`, so keep that directory (or move the
   scripts into the new configuration and update the paths). Run `conveyor config compare
   ~/.config/conveyor-v2 ~/.conveyor/config/conveyor.yaml` at any time to compare again.

3. **Move the credentials out of the unit.** The new unit carries no `CONVEYOR_*` variables. Put
   their values in `~/.conveyor/config/secrets.yaml` and reference them:

   ```yaml
   # secrets.yaml
   github_webhook_secret: "<CONVEYOR_GITHUB_WEBHOOK_SECRET>"
   session_secret: "<CONVEYOR_SESSION_SECRET>"       # keeps current dashboard sessions valid
   vapid_private_key: "<CONVEYOR_VAPID_PRIVATE_KEY>"
   ```

   ```yaml
   # in conveyor.yaml / providers.yaml
   web:
     sessionSecret: !secret session_secret
     push: { publicKey: "<CONVEYOR_VAPID_PUBLIC_KEY>", privateKey: !secret vapid_private_key, subject: "<CONVEYOR_VAPID_SUBJECT>" }
   # under providers.items.<github provider>:
   webhookSecret: !secret github_webhook_secret
   ```

   `CONVEYOR_USERNAME` and `CONVEYOR_PASSWORD_HASH` are no longer needed: the dashboard accounts are
   in the database already.

4. **Finish the home and check:**

   ```sh
   conveyor init            # creates the state directories; keeps the migrated configuration and the existing accounts
   conveyor doctor
   conveyor config check
   ```

5. **Switch over** at a quiet moment, ideally with nothing running on the board. Work that is running
   when the old service stops is interrupted and resumes after the new one starts.

   ```sh
   sudo cp /etc/systemd/system/conveyor.service ~/conveyor.service.source-checkout
   sudo systemctl stop conveyor
   cp ~/.local/share/conveyor-v2/conveyor.sqlite ~/conveyor.sqlite.before-release
   sudo conveyor service install --account ubuntu     # replaces conveyor.service
   sudo conveyor service start
   conveyor status
   ```

6. **Verify:** sign in to the dashboard with the same account, check that the board lists every
   item, and run `conveyor item show <item>` on one. `conveyor logs` shows the service log.

**Going back:** `sudo conveyor service stop`, restore `~/conveyor.service.source-checkout` to
`/etc/systemd/system/conveyor.service`, then `sudo systemctl daemon-reload && sudo systemctl start
conveyor`.

**Afterwards:** upgrade with `conveyor upgrade --version <tag>` instead of updating the checkout;
`scripts/deploy-when-idle.ts` is only for source-checkout deployments. Keep `~/.conveyor/config` in
a private Git repository if you like (without `secrets.yaml`).

## Adopting the reference configuration (source checkouts)

The rest of this guide predates the release layout. It describes how a source-checkout installation
adopted the reference configuration through a Git-pinned `import`. A pinned `import` and a
configuration directory still load (deprecated). Since this release, `examples/config` holds one
section value per file, which is what `!include builtin:<file>` uses, so an `import` pinned to a
newer commit no longer loads as before.

Conveyor ships a versioned reference configuration in `examples/config/` (providers, harnesses, agents, the `delivery` and `midgame-delivery` pipelines, and the agent instructions). The live service imports it at a pinned git commit; paths, secrets, repositories and scripts stay machine-local. Until the migration finishes, the legacy configuration keeps working through the compatibility compiler.

### What lives where

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

### Prerequisites (before any canary)

1. **Observe phase for each reconciling deploy script.** The reference marks the deploy of caravan, meal-planner, midgame and quesshi `recovery: reconcile`, as the design requires, but the current deploy scripts only implement `apply`. Add an `observe` phase to each before migrating that repository. The protocol is in [tasks.md](tasks.md#script-protocol): `observe` prints `{ "state": "already-applied", "operationId": ..., "result": <apply output> }`, `{ "state": "not-applied" }` or `{ "state": "indeterminate", "reason": "..." }`, and it must never change anything. After a restart the engine observes first and applies only when `not-applied`; `indeterminate` stops with `needs-intervention` rather than risk a duplicate deploy. Verify scripts are declared `replay-safe` and need nothing. Conveyor's own deploy is a no-op declared `replay-safe`, so the canary does not depend on this.
2. **Agent egress per repository.** For each repository run `bun scripts/check-agent-egress.ts <repository-id> --config <config-dir>`. It restores dependencies in the sandbox with an empty cache and only the repository's `agentEgress.httpsHosts`, proves the GitHub API and direct IPs are refused and lists every refused host so the allowlist can be completed. Needs the real network; not part of `bun test`.
3. **A live Codex smoke run inside the sandbox.** This has never been performed. Run one real Codex agent (any short task, for example refining a throwaway issue) with the sandbox and egress enforcement on, and confirm it reaches its model endpoint, reaches the run-scoped MCP socket, and cannot reach anything else. Do not canary before this passes.
4. `bun test` and `bunx tsc --noEmit` pass on the commit you will pin.

### 1. Shadow compare

Compile the current and the new configuration and read the differences before changing anything live:

```sh
bun run src/cli.ts check-config --config ~/.config/conveyor-v2 --compare /path/to/candidate-config   # with a release: conveyor config compare <current> <candidate>
```

The candidate directory is a copy of `examples/config` plus a local file with settings and repositories (or the same `import:` block). The command prints, for each repository present in either side and for each stage, the task sequences side by side (current on the left), then a summary: `added`, `removed` and `changed` tasks, including `onFail` routes, `wait` timeouts and polls, `with` values, and stage `concurrency`/`retries`. It exits 0; reading the summary is the review. Expect: the legacy `ci` stage gone (CI is now part of implementation and review gates), enter/exit checks replaced by exit gates, and no AI verifier.

Repository ids are matched by name. A repository present on one side only is listed as such; rename it in the candidate if the id changed so the comparison is meaningful.

### 2. Canary on `conveyor` itself

Conveyor's own repository is the canary: its deploy is a replay-safe no-op, and a failure affects only the delivery of Conveyor.

1. The issues of `conveyor` were offboarded for this refactor. After the refactor merges, re-enrol them (add the `conveyor` enrolment label); until then nothing runs there.
2. Migrate **while idle**: no issue should be mid-stage. Check the board (nothing running, parked or waiting) and stop `conveyor.service` via the deploy-when-idle script or by hand.
3. Pin the live configuration and combine it with the legacy files for the four repositories that stay on the legacy pipeline. Back up the legacy files first, then in `~/.config/conveyor-v2`:
   - Add the `import:` block, and keep `settings` and `web` as they are (the import never provides them).
   - Convert the legacy `sources`, `runners`, `codeHosts` and `ci` sections to the canonical names (`providers.items`, `harnesses`, `providers.code`, `providers.ci`) in one go: mixing old and new names across files is a configuration error. Entries the reference already defines with the same name (`github`, `github-poll`, `codex`, `process`, `actions`, `midgame-actions`) are provided by the import, so delete your copy; keep any entry of your own under its name.
   - Delete the top-level legacy `labels` section: the import's item providers carry the one shared labels block.
   - Rename the legacy agents that collide with the reference agents (`darya`, `kaveh`, `shirin`, `omid` become `darya-legacy`, `kaveh-legacy`, `shirin-legacy`, `omid-legacy`) and update every legacy pipeline's `run.agent` and `web.steering.agent` that names them. `mitra` and the `checks` section stay for the legacy pipelines.
   - The legacy pipeline `midgame-delivery` has the same name as the reference pipeline: rename it (`midgame-delivery-legacy`) and update the `pipeline` of the midgame repository. The other legacy pipeline names (`caravan-delivery` and so on) do not collide.
   - Replace the `conveyor` repository with its entry from `repositories.example.yaml` (pipeline `delivery`, `ci`, `agentEgress`, overrides); keep the other four repositories as they are for now.

   `tests/config/reference.test.ts` loads and compiles exactly this combination (the legacy fixture converted this way plus the reference import).
4. Run `check-config` against the live directory, then start the service.
5. Re-enrol one small issue and **watch one complete delivery**: refinement (criteria, labels), implementation (push, change, CI), review (findings and criterion approvals), merge, deploy, verify, cleanup. Read `check-config` output and the item's task history as you go. Required CI blocks if no CI is defined; reviews must record findings with `change.comment` before returning `changes-requested`.
6. When that delivery succeeds, re-enrol the remaining `conveyor` issues.

### Rollback

Rollback is a configuration change, not a code change:

- Pinned import: edit `import.ref` back to the previous commit (or tag) and restart. The hash changes and the previous reference is materialised again.
- Legacy files: restore the backed-up legacy files (and remove the `import:` block) and restart. Legacy stages keep working through the compatibility compiler.

Any configuration hash change restarts parked work. When an item's stored context carries a different `configHash` from the running configuration and it has a cursor in the stage (`#restartOnPlanChange` in `src/app/issue-executor.ts`), the engine bumps the stage epoch and restarts that stage from its beginning, posting one note ("The pipeline plan changed since <stage> started; the stage restarted from the beginning."). This applies to every item parked mid-stage when the pin changes, whether or not its own stage plan changed, and for a pin change or a rollback alike. Acts that already completed are reconciled, not repeated (observe first, then only missing work), so a restart does not duplicate pushes, pull requests or merges. Because the restart is triggered by the hash, **migrate and roll back while the board is idle** so nothing is parked mid-stage. Work already pushed or merged is untouched by a rollback.

Keep the legacy files and the previous pin until one complete delivery has succeeded in every repository.

### 3. The remaining four repositories

For each of caravan, meal-planner, midgame and quesshi, one at a time and while idle:

1. Its deploy script has an `observe` phase (prerequisite 1) and `scripts/check-agent-egress.ts` passed for it.
2. Point its `pipeline` at `delivery` (`midgame-delivery` for midgame) with the `repositories.example.yaml` entry (overrides for the deploy and verify script paths). caravan and meal-planner have `ci: { mode: disabled }` because they have no workflows; switch a repository to `required` only once it has a CI workflow.
3. Run the shadow compare for it, restart, and watch one complete delivery before moving on. Keep the rollback until it succeeds.

### After the migration

- Delete the legacy adapter paths (`legacy.*` tasks, the compatibility translator, the old `run`/`enterCheck`/`exitCheck` stage shape) and the Mitra agent, `checks:` section and `agent.verify` once all five repositories are migrated.
- Close #17 (non-blocking CI stage) in favour of `ci.mode: advisory` with `when: ci.required`.
- Re-scope #10 to the provider registry only; the task registry is done.
- #11 and #13 have open pull requests that need rebasing onto the merged work.
- Re-enrol the offboarded `conveyor` issues if not done in step 2.
