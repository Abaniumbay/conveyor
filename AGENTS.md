# Agent guide for Conveyor

Read this file before you change anything in this repository. It is written for coding agents.
Follow every **must** and **never** literally. When this file and the issue disagree, the issue
wins; say so in your result.

Background reading, only when the task needs it:

- [docs/architecture.md](docs/architecture.md) — components, the stage model, reliability rules.
- [SPEC.md](SPEC.md) — the detailed product contract. A change to behaviour it describes must update it.
- [CONTRIBUTING.md](CONTRIBUTING.md) — what a pull request needs.

## 1. What Conveyor is

Conveyor is a TypeScript service on **Bun 1.4** that moves GitHub issues through a configured
pipeline of stages (refinement, implementation, review, merge, …). Agents do the work; each stage
ends in a deterministic **exit gate** written in code. State lives in **SQLite** (`bun:sqlite`).
The **Preact** dashboard is an application that runs in the browser, fed by a live model the server
keeps and streams as patches. The CLI talks to the running service over a Unix socket.

This repository is **public**. Never write a real hostname, domain, IP address, login, repository
address other than `Abaniumbay/conveyor`, machine path or secret into code, tests, examples, docs,
commits or pull requests. Use `example.com`, `conveyor.example.com` and `owner/my-app`.

## 2. Commands

Run these from the repository root.

| Purpose | Command |
| --- | --- |
| Install dependencies | `bun install --frozen-lockfile` |
| Everything CI runs (tests + typecheck) | `bun run check` |
| Tests only | `bun test` |
| One test file | `bun test tests/app/retention.test.ts` |
| Tests whose name matches | `bun test -t "returns to implementation"` |
| Typecheck only | `bun run typecheck` |
| Regenerate `docs/tasks.md` | `bun run docs:tasks` |
| Regenerate `docs/cli.md` | `bun run docs:cli` |
| Regenerate `docs/events.md` | `bun run docs:events` |
| Regenerate dashboard screenshots | `bun run docs:screenshots` (needs `bunx playwright install chromium` once) |
| Run the CLI from source | `bun run src/cli.ts --help` |

`bun run check` must pass before you push. Never push code you have not seen pass.

## 3. Where things live

| Path | Contents |
| --- | --- |
| `src/app/` | The service (`service.ts`), issue execution, CI provider, retention, reports. |
| `src/engine/` | Stage executor, execution journal (epochs, cursors), review findings, manual gates. |
| `src/events/` | Event catalogue (`catalogue.ts`), the append-only event log (`log.ts`), the in-process bus (`bus.ts`), actor and correlation context. |
| `src/tasks/` | Task contract (`contract.ts`), every task group (`item.ts`, `change.ts`, `agent.ts`, …), the registry (`catalogue.ts`), the plan compiler, MCP dispatch. |
| `src/db/` | `migrations.ts` (schema) and `store.ts` (all SQL). |
| `src/config/` | `schema.ts` (zod schemas), loader, packaged defaults, migration. |
| `src/source/`, `src/codehost/` | GitHub issue adapter, managed body sections, pull requests and reviews. |
| `src/harness/`, `src/runner/` | Agent harnesses (Codex, Claude Code) and process runners. |
| `src/isolation/` | Sanitized agent environment, network sandbox, egress proxies. |
| `src/web/` | `server.ts` (HTTP routes, SSE), `model.ts` (the live dashboard model and its patches), `render.tsx` (Preact markup), `types.ts` (view models), `styles.ts` (CSS), `app/` (the browser application: `main.tsx`, `store.ts`, `derive.ts`, `behaviour.ts`). |
| `src/cli/` | `main.ts` (command table) and `commands/*.ts`. |
| `src/log/` | Structured logging (`log` from `src/log/logger.ts`). |
| `tests/` | Mirrors `src/`: the test for `src/x/y.ts` is `tests/x/y.test.ts`. |
| `tests/support/` | Shared fixtures: `delivery-world.ts` (a full delivery with fakes at the edges), `bwrap.ts`. |
| `examples/config/` | Packaged default configuration (`builtin:`), including the default agent instructions. |
| `docs/` | User and operator documentation. `tasks.md`, `cli.md` and `events.md` are generated; never edit them by hand. |

Some files are very large: `src/app/service.ts` (~6,000 lines), `src/db/store.ts` (~3,100),
`src/web/render.tsx` (~1,800), `src/web/server.ts` (~1,500) and `src/web/app/behaviour.ts`
(~1,000). Never read them whole. Find the symbol you need (code index or `rg -n "methodName" src`) and read a
narrow range around it.

## 4. Rules that protect correctness

These are how Conveyor stays correct across crashes, restarts and races. Breaking one is always a
blocking review finding.

1. **GitHub is authoritative.** Conveyor reads issues, labels, pull requests and checks from
   GitHub and keeps a local projection. Never treat the local projection as the source of truth
   for something GitHub owns.
2. **Stage epochs fence everything.** Every stage, state or enrollment change bumps the item's
   stage epoch (`ExecutionStore.onStageChange` in `src/engine/journal.ts`). Journal and context writes take the expected
   epoch and fail with `StaleEpochError` when it moved. Change an item's projection only through
   `store.setIssueProjection`; never write `projected_stage` / `projected_state` with your own SQL.
   One deliberate exception: while a step is parked on an agent's question, switching the state
   between `active` and `needs-input` in the same stage keeps the epoch and the cursor, so the
   answer can resume that step. `setIssueProjection` implements this; never remove it.
3. **External changes are idempotent.** Before an act changes GitHub, the workspace or anything
   outside the database, it records what it will do (a planned task execution or a source
   mutation with an idempotency key). On resume it observes the external state first and does
   only what is missing. A new act must follow the same pattern as the existing acts in
   `src/tasks/`.
4. **Gates are deterministic.** An exit-gate check reads recorded evidence and returns `pass`,
   `pending` or `fail` from `src/tasks/contract.ts`. It never calls a model and never guesses.
   A failure message says exactly what is missing.
5. **Domain failure vs infrastructure failure.** Return `fail(...)` for a domain failure (the work
   is not done). Throw `InfrastructureError` for a transient problem (network, GitHub outage,
   usage limit); the executor retries those with bounded backoff.
6. **Humans stay in control.** Conveyor never closes an ordinary issue directly and never merges
   without the gates passing. The service may close only an active completed roll-up parent with
   GitHub's `completed` reason after its descendant-completion rule passes.
7. **Agents get least privilege.** Agents reach Conveyor only through the run-scoped MCP grant.
   Never give an agent a token, a secret, a wider filesystem or network view, or a tool outside its
   grant. Never weaken anything in `src/isolation/`.
8. **No silent state.** Anything the dashboard shows as running must have a live run behind it,
   and anything stopped must have a recorded reason.

## 5. How to make common changes

Do every step listed for your kind of change. Missing one is the most common reason a review
sends work back.

### Database schema

1. Append a new object to the end of the array in `src/db/migrations.ts` with the next
   `version` number. **Never edit an existing migration**; production databases have already run
   it.
2. Put the SQL for the new data in `src/db/store.ts` methods. Do not add SQL anywhere else; the
   only other places with queries are the engine records in `src/engine/` and the read-only
   reports in `src/app/reports.ts` and `src/app/repository-summary.ts`.
3. Update the expected version in `tests/db/store.test.ts` (`expect(store.schemaVersion()).toBe(N)`).
4. A new query that sorts or filters a large table needs an index in the same migration.
5. A new write that changes state follows the event recipe below.

### State change (event)

Every change of Conveyor's state is recorded as an event, so the dashboard, the scheduler and
event sinks can react to it and the change can be traced.

1. Declare the event in `src/events/catalogue.ts` with its group, a one-line description and a
   strict zod payload. Payloads carry identifiers and states only: never secrets, tokens,
   passwords, hashes or user-written text.
2. Append it from the store or engine method that makes the change
   (`this.#events.append(...)` in `src/db/store.ts`, `eventLog(database).append(...)` in
   `src/engine/`), inside the same transaction as the write. Append only when something actually
   changed. Never append from a caller of that method.
3. React to an event by subscribing to the service's `EventBus`; never publish to it directly.
   Subscribers run after the transaction committed, in order.
4. Add a test in `tests/db/store-events.test.ts`: the change records its event, and an unchanged
   write records none.
5. Run `bun run docs:events` and commit `docs/events.md`. `tests/events/docs.test.ts` fails
   otherwise.

### Action (command)

Every action a person or the CLI takes is a command. The dashboard and the control socket never call
a service mutation directly.

1. Declare the command in `src/commands/registry.ts`: the role it needs (`user` or `superuser`),
   a description and a strict zod input. Add its result type to `CommandResults` in
   `src/commands/bus.ts`.
2. Register its handler in `ConveyorService.registerCommands` (or, for something only the process
   owning the control socket can do, in `src/control/server.ts`). A handler that changes a
   specific account checks that the actor owns it or is a superuser.
3. The route or control endpoint parses, authenticates and checks CSRF, then calls `dispatch` with
   the signed-in actor (`actorOf(session)`) or the CLI actor. Errors the bus raises
   (`CommandInputError`, `CommandForbiddenError`, `CommandUnavailableError`) map to 400, 403 and
   503; a handler's own error keeps the route's existing status.
4. A handler never calls `schedule()` or wakes a parked item to react to its own change: it records
   the change, and a subscriber in `ConveyorService.subscribeToEvents` reacts. A change that fences
   in-flight work (`onStageChange`) stays in the handler, synchronous.
5. Add a test that drives the route and reads `command.accepted` from the log
   (`tests/web/server.test.ts`, "dashboard commands").

### Task (gate check, act or agent tool)

1. Define it in the right group file in `src/tasks/` with `defineGroup`. Declare `kind`
   (`load`, `check`, `act`, `tool`), `reads`, `writes`, `invalidates`, its zod `config` / `input`
   schema and a precise `description` (it becomes documentation and the agent-facing tool text).
2. A new group is registered in `src/tasks/catalogue.ts`.
3. `tool` tasks are named in camelCase (`change.setMetadata`) and must check their preconditions
   through the dispatcher (an input `headSha` must equal the live change head).
4. Run `bun run docs:tasks` and commit `docs/tasks.md`. `tests/tasks/docs.test.ts` fails otherwise.
5. If agents should use it, update the default instructions in `examples/config/instructions/`.

### Configuration field

1. Add it to the zod schema in `src/config/schema.ts` (schemas are `.strict()`; unknown keys are
   errors).
2. Document it in `docs/configuration.md`.
3. If it has a packaged default, update `examples/config/`.
4. Test loading and validation errors in `tests/config/`.

### CLI command or option

1. Add or change the command in `src/cli/commands/*.ts` and its entry in `src/cli/main.ts`.
2. Run `bun run docs:cli` and commit `docs/cli.md`. `tests/cli/docs.test.ts` fails otherwise.

### Dashboard

1. Data is built in `src/app/service.ts` into the view models in `src/web/types.ts`, then
   normalized into the live model (`src/web/model.ts`) that the browser receives as a snapshot and
   patches. Data a view loads on its own comes from a JSON endpoint. `src/web/render.tsx` only
   renders; keep logic out of it.
2. Routes and JSON endpoints live in `src/web/server.ts`. A route that changes state requires a
   signed-in session and the CSRF token, and sends a command (see above); a superuser-only action
   checks the role on the server, not only by hiding a button.
3. The browser application is `src/web/app/`: `store.ts` holds the live model, `derive.ts` builds
   the view model for the address, `main.tsx` draws it with the components from `render.tsx`, and
   `behaviour.ts` handles clicks, forms and what a redraw re-applies. It is bundled by Bun, so it
   may import other modules, but nothing that needs Bun or Node at run time.
4. Styles are in `src/web/styles.ts`. Use the existing CSS variables (`--ink`, `--panel`, `--run`,
   `--stop`, `--text-sm`, …) for colour and size; never hard-code a colour. Both light and dark
   themes must work.
5. Every page must work at phone width (360 px) without horizontal scrolling.
6. Render user-provided text (issue titles, bodies, comments, agent output) as text. Never insert
   it as HTML.
7. If the layout changes, run `bun run docs:screenshots` and commit the images in
   `docs/screenshots/`.

## 6. Tests

- Use `bun:test` (`describe`, `test`, `expect`). Put the test at the path that mirrors the source
  file.
- Tests run offline with no credentials. Use temporary directories (`mkdtemp(path.join(tmpdir(), …))`),
  a temporary SQLite database and real `git` on local bare repositories. Never call GitHub or any
  network service.
- Never assert on the repository checkout's `changes/` contents or `CHANGELOG.md`. Releasing
  deletes every fragment, so such a test fails on the release commit. CI validates the fragments
  (`bun run changelog`), and `tests/release/fragment-guard.test.ts` fails any test outside
  `tests/release` that reads them. Test release tooling against a temporary repository.
- Fake only the outer edges: the code host, the CI provider, the GitHub issue adapter, the agent
  harness. `tests/support/delivery-world.ts` already wires these; reuse it for anything that
  crosses stages.
- Test behaviour through the public interface of the module under test. Never reach private
  members (`#field`, `private`) with casts or reflection, never widen visibility for a test, and
  never add test-only branches or flags to production code. If something cannot be tested from
  outside, restructure the code.
- Never mock or fake the unit under test, and never assert against a copy of its logic
  (hand-written SQL, a re-implemented algorithm).
- When an acceptance criterion lists several cases, write one assertion per case.
- A bug fix comes with a test that fails without the fix.
- Changed production code that no test executes is a missing test case. Test its behaviour with real
  assertions; never add a test solely to raise coverage.
- Browser tests (Playwright, `tests/web/refresh-position.test.ts` and `tests/web/app/main.test.ts`)
  are only for behaviour that needs a real browser: layout, scrolling, live refresh. Everything else is a plain unit test of
  `render.tsx` output or `server.ts` responses.
- Never weaken, skip or delete a failing test to get a green run.

## 7. Code style

- TypeScript is strict, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Handle
  `undefined` from indexing explicitly. Do not use `any` or `as unknown as`; validate untrusted
  input with zod.
- Use named exports. Import Node built-ins with the `node:` prefix (`node:fs/promises`,
  `node:path`). Use relative imports inside `src/`.
- Prefer Bun APIs where the codebase already does (`bun:sqlite`, `Bun.sleep`, `Bun.file`).
- Timestamps are ISO 8601 strings (`new Date().toISOString()`), stored as `TEXT`.
- Log with `log.info` / `log.warn` / `log.error` from `src/log/logger.ts`: a short message in
  sentence case and structured fields (`{ repository, item, stage }`). `warn` and `error` take the caught error as
  the third argument. Never log secrets or tokens.
- Comments explain *why*, in full sentences, and only where the code does not say it. Exported
  functions and classes that are not obvious get a one-line `/** … */`.
- Match the surrounding code: naming, file layout and existing helpers. Reuse an existing helper
  before writing a new one; search first.
- Keep a change to what the issue asks. Do not refactor unrelated code.

## 8. Before you finish

1. `bun run check` passes.
2. Generated docs are regenerated if you touched tasks (`docs:tasks`), the CLI (`docs:cli`) or
   events (`docs:events`).
3. Screenshots are regenerated if you changed dashboard layout.
4. A user-visible change adds a Markdown fragment under `changes/`, named with its positive issue
   number and a short slug. Its frontmatter selects Added, Changed, Deprecated, Removed or Fixed;
   use `breaking: true` when applicable. Write it for an operator: what changed for them, not how
   the code changed. Preview the combined notes with `bun run changelog`; do not edit Unreleased in
   `CHANGELOG.md`. The fragment is a standing rule, not an acceptance criterion: link no test to it.
5. A change to documented behaviour updates `docs/` and, where it describes it, `SPEC.md`.
6. No hostname, login, private repository address, machine path or secret anywhere in the diff.
7. Never change `version` in `package.json`; releases are cut by maintainers.
