# Changelog

All notable changes to Conveyor are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (before 1.0, a minor version may break compatibility).
Releases are published from tags by `.github/workflows/release.yml`; see
[docs/releasing.md](docs/releasing.md).

## [Unreleased]

See [changes/](changes/) and run `bun run changelog` to preview unreleased entries.

## [0.11.3] - 2026-10-18

Items start their next stage as soon as the previous one finishes, opened item details stay open through board refreshes, and a CI failure that repeats stops the item instead of retrying.

### Changed

- Required CI now stops an item for intervention when the same diagnosed failure repeats consecutively, retaining both failed-run links and focused log excerpts instead of repeatedly retrying.

- The packaged refinement instructions no longer turn release notes or changelog fragments into acceptance criteria. Every user-visible change still adds its fragment by repository rule; CI now validates the fragments on every pull request.

### Fixed

- Stages now schedule their next eligible work as soon as the finishing worker releases its capacity, rather than waiting for a later reconciliation or unrelated event.

- Opening an item now takes precedence over an earlier board refresh, so its details remain visible while the board updates.

## [0.11.2] - 2026-10-18

Conveyor no longer depends on stage names, a rebased branch can be pushed before its pull request exists, the Graph is drawn, acceptance criteria show one clear marker, and closed items recover.

### Changed

- The dashboard Graph now draws workflow items and their family and prerequisite connections. Filter it by repository or stage, open an item from its graph box, and use the accessible relationship list when you prefer text.

- Board repository filters now only filter the Board. Open repository details from **Show all**, the Repositories view, or a repository badge on a Board card.

- Acceptance criteria in item details now show one marker that combines linked-test evidence and current review approval, with a text label and guidance explaining the checks.

- **Breaking:** Conveyor no longer knows any stage by name; your pipeline configuration alone decides. If you use your own pipeline configuration, check three things:

  - **Merge repair routes come from `onFail`.** A changed head, a conflict or an outdated base at merge, and a failed `change.criterionTestsVerified`, now follow the action's `onFail`. Before, they always returned to a stage called `implementation`. Add `onFail: { return: <your build stage> }` to your `change.merge` action, as the packaged pipeline now does. Without it, these failures stop the item as `blocked`.
  - **Todos follow the tool grants.** Any agent granted the todo tools can keep the list. It is no longer tied to a stage called `implementation`; Conveyor closes out unfinished todos whenever the item moves on to its next stage, and a card shows todo progress while entries are still open.
  - **Stage icons come only from `icon:` in the pipeline.** A stage without one shows no icon.

### Fixed

- Closed items now continue from a confirmed current merged change, including a person-merged pull request, or are safely offboarded after Conveyor removes its control labels. Missed closure deliveries are recovered after an hour without disrupting open work.

- The default Operator now works only through its configured board tools in an empty, confined scratch filesystem. It can resolve common item references across configured repositories and explicitly reports when an item is not on the board.

- Lease-protected workspace pushes can now safely republish a rebased feature branch before Conveyor has created its pull request.

## [0.11.1] - 2026-10-18

Conveyor now keeps a copy of what it reads from GitHub in its database and answers every read from it; only an item it does not hold or one older than its configured lifetime is read from GitHub, which cuts an agent's GitHub calls during review to none and a full delivery to about a third. Merging no longer waits for GitHub to compute mergeability, and status comments are edited only when the status changes. Also adds board approvals per stage and pausing a repository from its page.

### Added

- Superusers can pause a repository from its dashboard page and later resume its preserved work without changing its configuration or item enrollment.

- Operators can require one board approval before an item leaves any current or later native stage. Board approvals wait after configured exit checks, including configured manual gates, and show separate controls and receipts in item details.

### Changed

- Conveyor keeps a copy of what it reads from GitHub in its database and answers every read from it.
  Only an item it does not hold, or one older than its lifetime (`settings.githubCache`: an hour for
  issues, pull requests and permissions, 15 minutes for running checks, finished checks kept), is read
  from GitHub. Webhook deliveries and Conveyor's own writes keep the copy current, and a restart reads
  nothing it already holds. Merging no longer waits for GitHub to compute mergeability: the merge
  decides. The issue's status comment no longer shows the next check or how long an item has been
  queued, so it is edited only when the status changes. On the offline benchmark, an agent's 30 tool calls during review now cost no GitHub
  request (92 calls before), a 20-minute CI wait 21 (44), and one item's delivery 22 (45).

### Fixed

- Release checks now run against a prepared scratch checkout, so changelog-fragment tests remain valid when a release consumes its fragments.

## [0.11.0] - 2026-10-17

Conveyor now reads GitHub only when it needs to. For repositories whose webhook it manages, an item entering a stage reads its issue once, deliveries update issues and decide finished CI without reads, nothing is read periodically, and a restart reads only what changed while Conveyor was stopped. Webhook health comes from deliveries and a ping after a quiet hour. Also fixes roll-up parent closing and the implementer's first workspace fetch.

### Added

- Configured Operator steering can now inspect stopped enrolled work on a periodic cadence. Scheduled runs
  are isolated from owner requests and may only retry or answer a target when they provide recorded evidence.

### Changed

- Conveyor reads GitHub only when it needs to. For a repository whose webhook it manages, an item
  entering a stage reads its issue once (every step of every item used to re-read the whole
  repository), issue and comment deliveries are applied from their payload, finished CI is decided
  from check-run deliveries, nothing is read periodically, and a restart reads only the issues changed
  while Conveyor was stopped. Webhook health now comes from deliveries: a quiet repository is pinged
  after an hour, and only an undelivered ping marks it unhealthy, as an alert that changes no
  behaviour. The CI settle window defaults to 30 seconds. `settings.events.reconcileInterval` and
  `fullReconcileInterval` are deprecated and have no effect. On the offline benchmark with 30 enrolled
  items, a restart goes from 158 GitHub calls to 6, an idle hour from 97 to 4, and one item's
  delivery from 243 to 45.

### Fixed

- Malformed secret configuration files now report only their file name and YAML position, so parser
  diagnostics cannot expose secret values.

- Closing a completed roll-up parent no longer counts as failed when GitHub closed it but answered with
  an error, and a parent that cannot be closed no longer fails the reconcile of its whole repository.

- An implementation agent's `workspace.fetch` no longer fails before the item's branch is first
  pushed (it reports that the branch is not on the remote yet), and a fetch that does fail tells the
  agent git's reason instead of only "MCP request failed".

## [0.10.0] - 2026-10-17

Conveyor now runs on an event log: every change is recorded as an event, dashboard and CLI actions are commands, and the live dashboard follows the events. With healthy webhooks it reads GitHub far less: waits for CI and blockers wake on webhook events, and the periodic reconcile becomes a light safety net. This release also adds a Graph view, GitHub call reporting, Sync now for a repository, and in-place manual gate controls.

### Added

- The dashboard now includes a read-only Graph view for following current item families and dependencies across repositories.

- `conveyor doctor` and repository dashboards now show public-repository trust safeguards,
  configured extra trusted logins, source-check uncertainty, and body-free skipped-review history
  links.

- Every change Conveyor makes is recorded in an event log ([events.md](docs/events.md)). `conveyor
  events` prints it (`--issue`, `--type`, `--correlation`, `--since`, `--follow`), every dashboard
  and CLI action shares one correlation id with the changes it caused, and `settings.events.sinks`
  delivers the log to a JSON-lines file for an external analyzer. Events are kept for
  `settings.events.retention` (30 days) and pruned by `conveyor cleanup`.

- `conveyor doctor` shows the last hour of GitHub calls by source (periodic reconcile, webhook, wait,
  fallback, agents, commands) with the remaining rate limit, and the service logs the same counts
  hourly and warns when less than a fifth of the limit is left. The repository page shows whether its
  webhook deliveries are healthy and its GitHub calls of the last hour. Conveyor also asks GitHub to
  redeliver webhook deliveries that failed in the last day.

- A **Sync now** button in the Setup section of a repository's page (superusers only) reads that
  repository afresh at once: every issue, each enrolled item's provenance and author permissions, sub-
  issues and blockers, pull request heads and CI, and the webhook's health. Use it after a change
  GitHub sends no webhook for, such as granting or removing a collaborator's permission.

### Changed

- Conveyor reads GitHub far less while webhooks deliver. A task waiting for CI or for its blockers
  now sleeps until the webhook event it waits for arrives (or its `settings.events.fallback`
  deadline passes) instead of re-reading GitHub every minute, and continues within seconds of CI
  finishing. Webhook deliveries read GitHub only for the issues they name, CI progress reads nothing,
  and while a repository's webhooks are healthy the periodic reconcile becomes a safety net: every
  30 minutes (`settings.events.reconcileInterval`) it reads only the issues changed since the last
  read, and every 24 hours (`settings.events.fullReconcileInterval`) and at start it reads everything,
  including each enrolled item's provenance and author permissions. In a 20-minute CI wait this cuts GitHub calls from 177 to
  50; an idle repository goes from 68 calls an hour to 8. Repositories without healthy webhooks keep
  polling as before.

- The live dashboard updates from recorded events instead of re-checking the database every second
  for each open page, and a page that reconnects catches up on what it missed.

- Manual gate controls work in place. **Approve gate** shows that it is sending and the item refreshes
  without leaving the page (it used to reload and jump to the board), and the item's own board
  approval requirement is a switch. An open item dialog now also refreshes its manual gates when they
  change.

- Unreleased changelog entries now live in independently mergeable `changes/` fragments, and
  `bun run changelog` previews the combined release notes.

### Removed

- New webhooks no longer subscribe to `deployment_status`, which nothing in Conveyor used; existing
  webhooks may keep sending it and those deliveries are recorded and ignored.

### Fixed

- Lease-protected workspace pushes now use the change head the agent observed and explain when a
  newer remote head must be fetched and reconciled before retrying.

- Roll-up parents now remain at the earliest unfinished descendant stage until merge-closed
  children finish their post-merge work, keeping their family rows visible on the board.

- Cleanup now reclaims restricted terminal run homes and warns once per unrecoverable run-home
  failure.

- Completed active roll-up parents now close with GitHub's completed reason once every descendant
  finishes, instead of remaining open with a closable label.

- Merge conflicts, changed pull-request heads, and outdated bases discovered after review now
  return through the bounded implementation repair path while retaining fresh CI and review gates
  for the repaired head.

## [0.9.0] - 2026-10-16

Conveyor 0.9.0 makes delivery safer and the dashboard calmer. Agent context and enrollment now require trusted GitHub provenance, review findings come only from trusted accounts, and implementers record test evidence for each acceptance criterion before review. The dashboard gains a Recent page, board filters, live storage warnings and sticky navigation, and live updates no longer interrupt scrolling. Configuration changes restart parked work only when that stage's own plan changed, so editing one repository no longer discards approvals elsewhere, and stopped post-merge work stays in Needs you.

### Added

- The Board now replaces its repository-card strip with compact repository, text, and state
  filters. Open cards filter immediately in the browser, share their state in the URL, and retain
  every open item; Done searches remain server-backed. The filter controls show filtered counts,
  preserve the full Needs you list, and collapse to a phone-friendly search and filter control.
- `conveyor cleanup` now also reclaims the private homes of finished runs of open, parked and
  stopped items; `--dry-run` reports how many and how much space, and recorded results, artifacts
  and logs are kept.
- Public `GET /version` now reports the running build's service, version, commit, and build time;
  public liveness responses also identify their version and commit.
- The dashboard now has a read-only **Recent** page that combines recent activity from every configured repository, with bookmarkable type and repository filters, expandable reasons, stable Load more paging beyond the initial 24-hour range, and independently timestamped Done completions.
- Implementers can record exact criterion-to-test evidence, which Conveyor projects into the pull request and verifies before review begins.
- Item details now show each acceptance criterion's linked test evidence, including its current
  approval state and revision-pinned source link.

### Changed

- A configuration change now restarts an item parked mid-stage only when the plan of that stage changed. Adding or removing a repository, or editing another pipeline or stage, no longer restarts parked work or discards manual approvals waiting at a gate.
- `conveyor config check` and `conveyor config compare` now mark manual native exit gates as
  `[check, manual approval]`; comparisons also report when only that approval setting changed.
- The built-in delivery pipeline now reviews a recorded child-breakdown plan before a separate, constrained work-breakdown stage creates its children. Interrupted creation reuses marked children and validates the completed breakdown before implementation.
- Native review findings now accept only GitHub authors with write-level repository access or configured extra trusted logins, preventing untrusted review text from reaching agents.
- Default review now waits durably for the current change head's CI checks to settle before starting the reviewer, even for advisory and disabled CI modes. The board shows the current head, unfinished checks, next poll, and finite deadline; both passing and failing settled CI continue to normal review (#246).
- `conveyor doctor` and `conveyor status` now warn when their artifact or temporary filesystem exceeds 85% capacity.
- The dashboard Server status now warns live when artifact, service-temporary, or agent-scratch storage exceeds 85% capacity.
- Board cards now load their details on demand, keeping ordinary board responses compact and updates focused on cards.
- Dashboard navigation now remains visible while scrolling; phone controls move into the System popover, and desktop board stage headings stay visible while their cards scroll.

### Fixed

- Agent and script launches now use one resolved filesystem path for their configuration,
  workspaces, artifacts, writable roots, and derived run directories, so symlinked data roots no
  longer break sandbox mounts or split a run's access boundary.
- Completed, failed, timed-out, and interrupted Codex agent, check, and steering runs now remove
  their private run home without removing retained results or artifacts.
- An answered question is recorded once in the item's conversation, with the answer and who gave
  it, and stays available to the agent after a stage restart.
- A live dashboard update no longer resets the scroll position. It moves the page only by the distance the card you are reading shifted, and not at all when nothing moved, so a scroll or swipe in progress is no longer interrupted.
- Enrollment labels and agent-visible issue text now require trusted GitHub provenance. Untrusted or unverifiable changes remain out of agent context and appear as board warnings instead.
- **Needs you** now retains stopped post-merge work when its merged Conveyor pull request has
  closed the source issue, so operators can act on its recorded reason.
- A stage fenced while it is running now releases its stale worker state immediately, so the board
  and scheduler do not wait for a service restart before the item can continue.
- Local and CI checks now keep Bubblewrap sandbox coverage visible while avoiding cleanup, socket-path, and shared-host timing flakes.
- Structured question choices that use legacy `value` identifiers are now answerable by that
  value from the CLI, dashboard, and issue conversation.
- Claude Code removes each run's private home after its process exits, including failed,
  interrupted, and timed-out runs, while preserving declared artifacts.
- Parent items now refuse new runs and direct retries while they have current children in any
  stage, while active or stopped parents keep their own status until ordinary item handling clears
  it. An already parked parent question can still resume its original run.

## [0.8.0] - 2026-10-14

Stage exit gates can wait for a human approval on the board, configured per pipeline or set per item. Answering an agent's question resumes it instead of restarting the stage, and the answer returns at once. The board's rows and the line fold with an animation, and the line starts closed on phones; a repository that cannot sync is called out on the board.

### Added

- A native stage exit gate can require a human approval: set `manual: true` on its `exit-gate`
  task, or, as a superuser, require it for one item from the board. The item waits in Needs you
  until a superuser approves it; the approval is recorded in the item's history, never bypasses a
  failing automatic check, and is needed again on a retry, a return to the stage, or a plan restart.
- A configurable `labels.metadata.noSplit` label (defaulting to `<enrollment>:no-split`) keeps an
  issue whole during refinement. Conveyor preserves this human-managed label, refuses child
  creation while it is present, explains the constraint to refiners, and marks the dashboard card
  and details.

### Changed

- Folding and unfolding a board row animates like an accordion (an ease-out height and fade); with
  reduced motion it stays instant. A folded row's cards leave the tab order and the accessibility tree.
- On a phone, a family's cards are indented under the parent's band, so they read as its children.
- Answering a question returns at once: the answer is recorded, the source's needs-input label
  cleared and the agent resumed, while mirroring the answer as a comment, re-syncing the repository
  and the status comment follow in the background (the comment is retried). The Answer button
  shows "Answering…" while it sends, and the board refreshes in place afterwards.
- The line folds: its heading has a fold arrow, it is open on wide screens and closed on phones
  until you choose, and the choice is remembered in the browser.
- Each active item now keeps its agent scratch directory beside its worktree rather than in the
  host temporary directory. Scratch persists between that item's agent runs and is removed with
  the workspace; workspace-free runs still clean their private scratch when they finish.

### Removed

- The Board's Repositories strip. The Repositories tab lists every repository, and each card
  already names its repository. A repository that cannot sync is still called out on the Board:
  a notice above the line names it, gives the error, and links to its page.

### Fixed

- Answering an agent's question resumes the agent with the answer again. Since 2026-10-10 the
  item's switch to needs-input (and back) restarted its stage, dropping the step that waited for
  the answer, so the agent started over and asked the same question again.

## [0.7.0] - 2026-10-14

This release redesigns the board. Stages are Jira-style columns with compact headings, an emoji and an information dialog (description, team and usage). Each open parent is a foldable row holding its children in their stages, and dependencies show their state, what each item blocks, and can be traced along their whole chain. On a phone the board lists its stages top to bottom.

### Added

- Superusers can reset dashboard account passwords or delete regular accounts from Accounts, and
  `conveyor admin delete-account <username>` provides the same protected deletion from the shell.
- The board shows each open parent as a row. The stations stay across the top. Each parent's row
  holds its children as cards in their stations, and its header shows the parent's number and
  title, one square per child (done, running, waiting, stopped), `done/total`, the parent's own
  stop when it has one, and **Details**. Items without a parent share a row at the bottom. Rows
  fold to their header, and each browser remembers which are folded. A finished family shows
  only its parent, in Done. On a phone, a family row lists its cards in stage order, with the
  stage on each card.
- Dependencies show what they are waiting on and what they hold up. A card's unfinished
  dependencies are chips, and one whose blocker is stopped turns red and names the state
  (`#245 · Blocked`). A card, or a family row, that unfinished items wait on gets a **Blocks N**
  chip. Tapping a chip traces the chain both ways across the rows, through parents too: what it
  waits on is outlined in red, what waits on it in blue, the rest dims, and folded rows holding
  part of the chain open. A floating bar lists the direct links and counts the whole chain.
  **Show everything**, the chip again, or Escape clears it.
- Stage columns look like a Jira board: soft filled columns without borders, every heading the
  same height with an emoji, the name, an information button and the count. On wide screens the
  board is its own scroll area, so its sideways scrollbar is always on screen and the headings
  stay at its top. The information button opens a dialog with the stage's description, who works
  there and its usage. Pipelines can set a stage's `description` and `icon` (an emoji) in YAML; the
  reference pipelines set both, and the usual stage ids get an emoji by default.
- On a phone the board lists its stages top to bottom, with no sideways scrolling.

### Changed

- Stage columns no longer pull parents into a separate "Roll-up parents" group, and a parent is
  no longer a card in its column: it heads its family's row.

### Fixed

- Stopped items that have not yet received a stage label remain visible in the dashboard backlog
  instead of appearing as label problems.

## [0.6.6] - 2026-10-13

This release stops the dashboard from jumping during live updates. An update used to download the whole page and swap it in, which moved whatever you were reading. The browser now tells the server which cards it already holds, the server sends only the cards that changed, and the page is patched in place, so an unchanged card never moves. Updates also wait while you are touching or scrolling, and scrolling while one loads is no longer undone.

### Changed

- A live update no longer replaces the dashboard. The browser tells the server which cards it
  already holds, the server sends only the cards that changed (the rest come back as placeholders),
  and the page is patched in place: an unchanged card is never taken out of the page, so there is
  nothing to scroll back to. On a board of 70 cards an update was 680 KB of HTML swapped wholesale;
  it is now the page's frame plus the changed cards. An update also waits while a finger is on the
  screen or a scroll is still coasting. Navigation still loads a whole page.

### Fixed

- Scrolling while a live update loads no longer snaps the dashboard back. The reader's position was
  remembered before the update was requested and put back after it arrived, so anything scrolled in
  between, vertically or across Board columns, was undone; on a slow page that was several hundred
  pixels on every update. The position is now taken at the moment the page is replaced.

## [0.6.5] - 2026-10-13

This release fixes dashboard pages taking seconds to load. Every card rebuilt the scheduler's view of all items to work out its queue status, so a page cost one pass over every item per card; on an installation with 415 items that was 2.8 seconds for every page and every live refresh. The view is now built once per page.

### Fixed

- Dashboard pages no longer take seconds to build. Every card worked out its queue status by
  rebuilding the scheduler's view of all items, so a page cost one pass over every item per card:
  2.8 seconds for 70 cards over 415 items, on every page and every live refresh. The view is now
  built once per page (225 ms on the same data).

## [0.6.4] - 2026-10-13

This release makes the dashboard fast again on installations with a long run history. Rendering a page read every run once per item to total its cost, and each open tab's live-update stream scanned the whole run event table on every tick, which blocked the service for seconds at a time. Upgrading adds three database indexes that turn these into lookups.

### Fixed

- The dashboard no longer slows down as run history grows. Rendering a page read every run once per
  item to total its cost, and each open tab's live-update stream scanned the whole run event table
  on every tick; on an installation with 85,000 run events that was about 1.5 seconds per page and
  0.3 seconds per tick, during which the service answered nothing else. Three indexes, added on
  upgrade, make these lookups.

## [0.6.3] - 2026-10-13

This release stops agents from downloading their toolchains' package caches on every run and from leaving scratch behind in `/tmp`. Agents take an `env` setting that points tools such as NuGet, pub, Gradle and npm at the shared caches listed in `writableRoots`. A workspace-write Codex run can now write its own home and gets a temporary directory of its own, which Conveyor deletes when the run ends; set `TMPDIR` for the service to keep that scratch off a memory-backed `/tmp`.

### Added

- Agents take an `env` setting: environment variables for the agent's run, with `~/` values
  expanded. A run's `HOME` is an empty directory of its own, so toolchains never found the package
  caches listed in `writableRoots` and downloaded them again on every run; `env` points them there
  (`NUGET_PACKAGES`, `PUB_CACHE`, `GRADLE_USER_HOME`, `npm_config_cache` and so on). Credential-like
  names are still dropped. The example configuration sets them for its implementers.

### Changed

- A `workspace-write` Codex run can write its own `HOME`, and gets a temporary directory of its own
  as `TMPDIR`, deleted when the run ends. Agents used to work around an unwritable home by building
  one under `/tmp` and leaving it there. The directory is created under the service's temporary
  directory: set `TMPDIR` for the service to keep agent scratch off a memory-backed `/tmp`.

## [0.6.2] - 2026-10-13

This is the first published build of the changes listed under 0.6.1, whose tag failed its release checks and published nothing. It lets an agent write its pull request's description: `change.setMetadata` now stores a Markdown description in a managed section of the pull request, so a criterion that asks for a statement in the pull request no longer needs a person to edit it. Todos left unfinished when their stage passes are marked skipped instead of staying open, and upgrading does the same for items already past that stage. It also fixes the dashboard losing your place during a live refresh on phones. See the 0.6.1 section of the changelog for the details.

### Fixed

- The Release workflow installs the browser that its checks need. The `v0.6.1` tag failed those
  checks for want of it and published nothing, so the changes listed under 0.6.1 first ship in
  this release.

## [0.6.1] - 2026-10-13

Tagged but never published: the Release workflow failed before building anything. These changes
ship in the next release.

This release lets an agent write its pull request's description and tidies up todo lists once a stage is finished. `change.setMetadata` now stores a Markdown description in a managed section of the pull request, so a criterion that asks for a statement in the pull request no longer needs a person to edit it. Todos left unfinished when their stage passes are marked skipped instead of staying open, and upgrading does the same for items already past that stage. It also fixes the dashboard losing your place during a live refresh on phones.

### Added

- `change.setMetadata` writes a pull request description. It takes a Markdown `description` (an
  empty string clears it) and stores it in a `conveyor:description` managed section of the pull
  request body, after the `Closes #N` line and before the acceptance criteria. Text outside the
  managed sections is left exactly as it was, and repeating the same description makes no update.
  An implementer can now meet a criterion that asks for a statement in the pull request without a
  person editing it. Descriptions are limited to 32,000 characters, and `title` and `labels` are
  no longer accepted.

### Changed

- When the stage whose agent owns an item's todo list passes its exit gate, the todos still
  `pending` or `in_progress` become `skipped`, a new final status that only Conveyor sets, with a
  short note saying why. Done entries are unchanged, skipped entries stay as history if the item
  returns to that stage, and agents cannot set or edit them. Progress now counts done and skipped
  entries as finished, so a completed item no longer shows unfinished todos.
- Board cards show todo progress only while the item is in the stage that owns the list. Item
  details still show the whole list in every stage, with skipped entries labelled.
- Upgrading closes the unfinished todos of items that are already past their todo-owning stage,
  with the same status and note.

### Fixed

- Live dashboard refreshes now keep the currently read card and Board stage aligned on phone-sized
  screens, while safely clamping the previous scroll offsets if that card no longer exists.

## [0.6.0] - 2026-10-12

This release is a quality pass over the dashboard. It fixes keyboard access to an item's tabs, focus and page titles when moving between views, and the sign-in card on phones; the header no longer overlaps at medium widths, repository cards share one size, and dialogs and menus open and close smoothly. Pages are now compressed. It also stops the dashboard from showing the sign-in page when it is opened from a link on another site, and renews sessions while the dashboard is in use.

### Changed

- Dashboard sessions are now renewed while the dashboard is in use: loading a page extends a session
  that is past half its lifetime, so only a full session lifetime without a visit signs you out. The
  session cookie is `SameSite=Lax` instead of `Strict`.
- The dashboard header wraps instead of letting its texts overlap at medium widths, repository cards
  share one size and truncate long names, addresses and errors, each stage's count sits beside its
  name, and the "needs you" shortcut is a separate alert at the end of the navigation row rather
  than a tab.
- Item and agent dialogs and the header menus open and close with a short transition, which is
  skipped when the system asks for reduced motion.
- Pages are compressed and the dashboard scripts are revalidated instead of downloaded with every
  page. Dashboard responses ask search engines not to index them.
- The Line on a repository page lists its counts as text instead of links to the Board.

### Fixed

- Opening the dashboard from a link on another site (a GitHub comment, an email, a chat) no longer
  shows the sign-in page while you are still signed in, and the sign-in page forwards visitors who
  are already signed in.
- The Conversation, Journey and Technical logs tabs of an item can be reached with the keyboard
  (arrow keys, Home and End).
- The sign-in card is no longer clipped on phone-width screens.
- Following a link inside the dashboard keeps keyboard focus and announces the new view, every view
  has its own page title, and a "Skip to content" link comes first.
- Live updates keep the focused control and half-entered answers, and wait while you are typing or
  have a header menu open.
- Issue and agent cards open from a real button, status text meets contrast requirements in the
  light theme, report charts and tables are exposed to assistive technology, and touch targets are
  larger on touch screens.

## [0.5.1] - 2026-10-12

This patch hides the open questions of offboarded items, so they no longer appear in Needs you and
can't be answered. The questions are kept and become visible again when the item is re-enrolled.

### Fixed

- Offboarded items with open questions no longer remain visible or answerable. Their questions stay
  stored and become visible again when the item is re-enrolled.

## [0.5.0] - 2026-10-11

The Board now shows the repositories Conveyor works for, with a list page and a read-only page per repository. This release also keeps a parent item stopped in refinement until its own refinement passes, lets a child depend on an open item outside its parent, reports item tool input errors to the agent, and resumes agent stages after a service restart instead of blocking them.

### Fixed

- Parent items now remain stopped in refinement until their own refinement run passes, even when a
  partial split has already created children. Retrying such a parent resumes refinement with its
  existing children instead of treating it as a completed roll-up.
- `item.createChild` now accepts open, Conveyor-enrolled same-repository blockers outside its
  roll-up and returns actionable validation errors for invalid dependency targets.

### Added

- The Board now includes a Repositories strip for configured repositories, including their health
  and current work, with read-only repository list and detail pages.

## [0.4.3] - 2026-10-10

Refinement can now order the children it creates, and three pipeline defects that stalled items are fixed: writes made during refinement are visible to its own gates on polled repositories, enrolled issues first seen as dependencies are queued, and unconfigured refinement outputs report a clear error instead of a bare failure.

### Added

- `item.createChild` can record dependencies on already-created sibling children with `dependsOn`,
  so ordered refinement work remains blocked until its foundation is complete.

### Fixed

- Successful item writes now immediately update the stored issue and relationship snapshots used by
  refinement gates, so labels, managed body sections, parent-child links, and dependencies are
  visible in the same run even when a source is polled without webhooks.
- Issues first stored as dependencies are now enrolled and queued when their repository snapshot
  carries the Conveyor label, rather than remaining active without a queue position.

## [0.4.2] - 2026-10-10

This patch makes questions answerable from the dashboard again and fixes the dashboard on phones. Since 0.4.0, questions whose choices agents stored as a label and description showed an error in Needs you instead of their choices. On phones, a CI chip on a card outside the visible stage widened the page so it could be dragged sideways into empty space, and long content was cut off in the Operator view and in item conversations. An upgrade also no longer hangs when the old process stalls while shutting down.

### Fixed

- Supervised release restarts now force a failed exit if shutdown cleanup stalls, rather than
  waiting for the service unit stop timeout.
- Questions whose choices were stored as a label and description, which is what agents write, show
  their answer choices in Needs you again. Since 0.4.0 they showed an error and could not be
  answered from the dashboard.
- Needs you no longer lists questions and stops of closed or paused (unenrolled) items. They are
  kept and show again when the item is reopened or resumed.
- The dashboard no longer becomes wider than a phone screen when a card outside the visible stage
  shows a CI chip, which let the page be dragged sideways into empty space. The Operator view,
  item conversations and journeys also wrap long content at phone widths instead of cutting it off.

## [0.4.1] - 2026-10-10

This release replaces 0.4.0 and the releases before it, which were withdrawn when installation-specific details were removed from the repository's history. Conveyor itself behaves exactly as in 0.4.0; the release adds a contributor guide. If you install a specific version, use this one: the earlier tags and downloads no longer exist.

### Added
- `CONTRIBUTING.md` describes how to report problems, the development setup and what a pull request
  needs.

### Changed
- Releases 0.2.0 to 0.4.0 were withdrawn and their tags removed when installation-specific
  details were taken out of the repository's history. Their notes stay below. Install or upgrade to
  this release instead; it contains everything 0.4.0 did.

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
