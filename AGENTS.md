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
A **Preact** dashboard is rendered on the server. The CLI talks to the running service over a Unix
socket.

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
| Regenerate dashboard screenshots | `bun run docs:screenshots` (needs `bunx playwright install chromium` once) |
| Run the CLI from source | `bun run src/cli.ts --help` |

`bun run check` must pass before you push. Never push code you have not seen pass.

## 3. Where things live

| Path | Contents |
| --- | --- |
| `src/app/` | The service (`service.ts`), issue execution, CI provider, retention, reports. |
| `src/engine/` | Stage executor, execution journal (epochs, cursors), review findings, manual gates. |
| `src/tasks/` | Task contract (`contract.ts`), every task group (`item.ts`, `change.ts`, `agent.ts`, …), the registry (`catalogue.ts`), the plan compiler, MCP dispatch. |
| `src/db/` | `migrations.ts` (schema) and `store.ts` (all SQL). |
| `src/config/` | `schema.ts` (zod schemas), loader, packaged defaults, migration. |
| `src/source/`, `src/codehost/` | GitHub issue adapter, managed body sections, pull requests and reviews. |
| `src/harness/`, `src/runner/` | Agent harnesses (Codex, Claude Code) and process runners. |
| `src/isolation/` | Sanitized agent environment, network sandbox, egress proxies. |
| `src/web/` | `server.ts` (HTTP routes, SSE), `render.tsx` (Preact markup), `types.ts` (view models), `client.ts` (browser script), `styles.ts` (CSS). |
| `src/cli/` | `main.ts` (command table) and `commands/*.ts`. |
| `src/log/` | Structured logging (`log` from `src/log/logger.ts`). |
| `tests/` | Mirrors `src/`: the test for `src/x/y.ts` is `tests/x/y.test.ts`. |
| `tests/support/` | Shared fixtures: `delivery-world.ts` (a full delivery with fakes at the edges), `bwrap.ts`. |
| `examples/config/` | Packaged default configuration (`builtin:`), including the default agent instructions. |
| `docs/` | User and operator documentation. `tasks.md` and `cli.md` are generated; never edit them by hand. |

Some files are very large: `src/app/service.ts` (~3,600 lines), `src/db/store.ts` (~2,200),
`src/web/client.ts` (~2,000), `src/web/render.tsx` and `src/web/server.ts` (~1,250 each). Never
read them whole. Find the symbol you need (code index or `rg -n "methodName" src`) and read a
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

1. Data for the page is built in `src/app/service.ts` into the view models in `src/web/types.ts`.
   `src/web/render.tsx` only renders; keep logic out of it.
2. Routes and JSON endpoints live in `src/web/server.ts`. A route that changes state requires a
   signed-in session and the CSRF token; a superuser-only action checks the role on the server,
   not only by hiding a button.
3. `src/web/client.ts` exports browser code inside a `String.raw` template (`dashboardClient`).
   Functions spliced in with `.toString()` must be self-contained: no imports, no references to
   module-level names. Inside the template, a backtick or `${` must be escaped.
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
- Browser tests (Playwright, `tests/web/refresh-position.test.ts`) are only for behaviour that needs
  a real browser: layout, scrolling, live refresh. Everything else is a plain unit test of
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
2. Generated docs are regenerated if you touched tasks (`docs:tasks`) or the CLI (`docs:cli`).
3. Screenshots are regenerated if you changed dashboard layout.
4. A user-visible change adds a line under `## [Unreleased]` in `CHANGELOG.md`, in the section
   Added, Changed, Deprecated, Removed or Fixed. Write it for an operator: what changed for them,
   not how the code changed.
5. A change to documented behaviour updates `docs/` and, where it describes it, `SPEC.md`.
6. No hostname, login, private repository address, machine path or secret anywhere in the diff.
7. Never change `version` in `package.json`; releases are cut by maintainers.
