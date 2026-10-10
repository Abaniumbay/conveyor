# Changelog

All notable changes to Conveyor are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (before 1.0, a minor version may break compatibility).
Releases are published from tags by `.github/workflows/release.yml`; see
[docs/releasing.md](docs/releasing.md).

## [Unreleased]

### Added
- `CONTRIBUTING.md` describes how to report problems, the development setup and what a pull request
  needs.

## [0.4.0] - 2026-10-10

This release removes installation-specific configuration from Conveyor and fixes three dashboard and refinement problems. **Breaking:** the built-in `midgame-actions` CI provider and `midgame-delivery` pipeline are gone, and the `allowedHumanLogins` provider setting is no longer accepted, so a configuration that still contains it fails validation. Before upgrading, copy any of those definitions you still use into your own configuration and delete `allowedHumanLogins`. Questions asked on a parent item during refinement now stay answerable after child issues exist, the dashboard fits a phone viewport, and an installed PWA reconnects its live updates after standby.

### Changed
- Removed the installation-specific `midgame-actions` built-in CI provider and
  `midgame-delivery` pipeline. Copy any definition still used by an installation into private
  configuration before upgrading.
- Removed the `allowedHumanLogins` provider setting. Existing configurations that contain it now
  fail validation; dashboard authentication remains the authorization boundary.

### Fixed
- Prevented document-wide horizontal overflow in the dashboard at phone viewport widths while
  preserving the Board, navigation, report, and item-detail scrollers.
- Restored dashboard live updates after an installed PWA resumes from standby by reconnecting a
  stale event stream and catching up the current dashboard view.
- A question asked on a parent item during refinement stays open and answerable after that run
  created child issues. The parent stays in refinement, and its children do not start until the
  answered refinement run completes. The dashboard's answer form works for choice and free-text
  questions, and an answer whose mirroring to the issue failed can be retried without being lost or
  posted twice (#144).
- The dashboard's account menu no longer shows a second Change password link; the password is
  changed on the Profile page (#126).

## [0.3.1] - 2026-10-07

This patch fixes a webhook feedback loop that could use up the GitHub API rate limit within minutes. Each status-comment write sent a webhook back to Conveyor, and that webhook rewrote every item's status comment. Webhooks are now acknowledged at once and handled in the background, and Conveyor makes far fewer GitHub calls. When GitHub does refuse requests for a rate limit, Conveyor pauses them until the limit resets.

### Fixed
- Conveyor no longer exhausts the GitHub API rate limit with a webhook loop. Each status-comment write came back as an `issue_comment` webhook. That webhook triggered a full reconcile and rewrote the status comment of every item, which sent more webhooks. Deliveries for Conveyor's own status comments are now ignored. The status comment no longer shows the issue's `Updated` time, which changes whenever the comment is edited.
- Webhook deliveries are acknowledged at once and processed in the background, so a slow reconcile no longer fails the delivery (GitHub never retries failed deliveries). Deliveries that arrive while a pass is queued join it, and only the status comments of the issues a delivery names are refreshed.
- Conveyor makes fewer GitHub calls:
  - Webhook reconciles read only the issues changed since the last read. The whole issue list is still read by polling and at least hourly.
  - Sub-issues and blockers are read again only when an issue changes, a relationship webhook arrives, or an hour has passed.
  - Status comments are updated by their known id instead of listing the issue's comments first.
  - The live pull-request head is read once per reconcile rather than on every status write.
- After a rate-limit refusal, GitHub requests pause until the limit resets instead of failing one by one against GitHub.

## [0.3.0] - 2026-10-07

Conveyor now shows what an item is waiting for: live CI status on board cards and item details, queued items with the limit and the items holding their slots, and which acceptance criteria the reviewer approved. Agent runs get the item's current handover in their prompt, and refinement can record the issue type, fields and a Refinement section on GitHub. It also fixes Codex runs that failed on strict result schemas and keeps completed todos when an agent rewrites its list.

### Added
- Refinement can record the GitHub issue type, organization issue fields (for example Effort) and a managed Refinement section on the issue (`item.setType`, `item.setFields`, `item.setRefinement`, and the same values in `item.createChild`). A per-repository `refinement` setting lists the writable fields and what the new `item.refinementComplete` gate requires.
- The dashboard's item details show the issue type and configured field values; `conveyor doctor` checks the credentials' access to them.
- Board cards and item details show each item's CI status for the change's current head: a compact chip on the card and, in the details, each run with its state, start time and duration. Status is stored per item, survives restarts and updates live from `workflow_run` and `check_suite` webhooks (#117).
- Items that are due but cannot start show as Queued, naming the full runner, stage or repository limit and the items holding its slots. A parked `ci.passed` gate shows the latest known CI state instead of its last evaluation message (#119).
- The issue status comment and the item details show which acceptance criteria the reviewer approved at the change's current head (#122).
- Every `agent.run` prompt includes the item's current handover: todos, open review findings, the change and its CI state, and the worktree (#116).
- `bun run docs:screenshots` regenerates the documentation screenshots from an isolated demo instance (#107).

### Changed
- The board summaries (The line, Needs you) appear only on Board, so other dashboard pages start at the top, and the dashboard navigation is simplified (#105).

### Fixed
- Codex result schemas are valid for strict structured output; Codex runs no longer fail before starting with `Invalid schema for response_format 'codex_output_schema'` (#110).
- `todo.set` keeps completed todos when an agent rewrites the list, so recorded progress is no longer lost (#112).
- The dashboard header and tabs stay usable at phone width (#104).
- The dashboard's Content Security Policy allows its web app manifest (#103).
- The managed acceptance-criteria section now has an "Acceptance Criteria" heading, and replaces a hand-written checklist instead of appearing beside it.

## [0.2.1] - 2026-10-06

Fixes the dashboard in the released executable, which stopped at load in 0.2.0.

### Fixed

- The dashboard works again in the released executable. Its browser script stopped at load with a
  `ReferenceError` (for example `rS is not defined`), so the page showed "not connected" and
  navigation did nothing. The quota countdown code it embeds referred to a helper by a name the
  minified build renames.

## [0.2.0] - 2026-10-06

The first release of Conveyor as a standalone package.

### Added

- Conveyor ships as one self-contained Linux executable per architecture (x64; arm64 when its tests
  pass). It embeds the Bun runtime, dashboard, fonts, result schemas, packaged default configuration,
  MCP server and sandbox bridge, and it is published on GitHub Releases with `install.sh` and
  `checksums.txt`. Installing it needs no source checkout, no `node_modules` and no Bun.
- `install.sh` verifies the checksum and installs into `<prefix>/versions/<version>`, switching
  `<prefix>/current` atomically.
- A Conveyor home (`--home`, `CONVEYOR_HOME`, default `~/.conveyor`) keeps configuration, state,
  logs, artifacts and worktrees apart from the installed executable.
- A single configuration entrypoint, `conveyor.yaml`, with `!include`, `!include_dir_named`,
  `!include_dir_merge_named` and `!secret` (from a git-ignored `secrets.yaml`), and with packaged
  defaults through `!include builtin:<file>`.
- Errors name the file and the key path. Include cycles, duplicate keys and missing secrets are
  diagnosed. Secrets are redacted wherever configuration is shown or stored.
- New CLI commands, with `--help`, `--json` and stable exit codes:
  - `init`, `doctor`, `version`
  - `config check | show | compare | migrate | builtin`
  - `serve`, `service install | start | stop | restart | status | uninstall`
  - `status`, `board`, `item show | history | logs | retry | pause | resume`
  - `questions list | answer`, `logs`
  - `upgrade`, `rollback`, `cleanup`, `diagnostics export`, `admin reset-password`
- A local control socket (`<home>/run/control.sock`, private to the service account) through which
  the CLI uses the same service operations as the dashboard.
- Pausing and resuming an item from the CLI (it removes or restores the enrollment label).
- Draining: the service stops admitting work while running work finishes. It is used by
  `service stop --drain`, `service restart --drain`, `upgrade` and `rollback`.
- `upgrade` and `rollback` drain, back up the database, switch releases, restart and verify. An
  upgrade requested by Conveyor's own deploy stage (`upgrade --no-wait`) switches after that stage
  ends.
- `rollback --restore-backup` returns to the pre-upgrade database when an upgrade migrated it. An
  older release refuses a database migrated by a newer one.
- Service logging to stdout/stderr and `<logs>/conveyor.log`: JSON lines, rotated by size
  (`settings.logging`). Records are correlated by repository, item, stage and run, and redacted.
- Retention of finished work (`settings.retention`) for run events and run artifacts of closed,
  done or offboarded items.
- Script interpreters: `script.run`, legacy script stages and check scripts take `interpreter` (for
  example `[python3]`). Scripts without one still run as `bun run <script>` and need Bun installed.
- `web.sessionSecret`, `web.push` and the GitHub provider's `webhookSecret` can be set in the
  configuration (for example with `!secret`). The `CONVEYOR_*` environment variables still work.

### Changed

- **Breaking:** the default dashboard address of a `conveyor.yaml` entrypoint is `127.0.0.1:7788`
  (it was `127.0.0.1:4300`). A configuration directory keeps 4300, and `config migrate` writes the
  address out, so a migrated configuration keeps its port.
- **Breaking:** with a Conveyor home, a single-file configuration's unset `settings.database`,
  `logs`, `workspaces` and `artifacts` default to `<home>/state/conveyor.sqlite`, `<home>/logs`,
  `<home>/worktrees` and `<home>/artifacts`. They were `<config dir>/data/...`; set them explicitly
  to keep the old locations. A configuration directory keeps its old defaults.
- **Breaking:** `examples/config` holds one section value per file (`providers.yaml`,
  `harnesses.yaml`, `agents.yaml`, `pipelines.yaml`), so each can be included. The parsed content
  is unchanged. A pinned `import` of a commit from before this change still reads the old layout.
- `serve` no longer requires `CONVEYOR_USERNAME`, `CONVEYOR_PASSWORD_HASH` or
  `CONVEYOR_SESSION_SECRET`. Accounts live in the database (`conveyor init` creates the first). The
  session secret is generated once and kept beside the database, and the variables still work.
- `check-config` is now `config check` and `config compare`; the old spelling remains as an alias.

### Deprecated

- Loading a configuration directory (`--config <dir>`), and the Git-pinned `import`. Both still
  work with a warning; `conveyor config migrate` converts to a tag-based `conveyor.yaml`.

### Removed

- `conveyor hash-password --password <value>`, which put the plaintext password in the command
  line. Use `conveyor init` or `conveyor admin reset-password`.
