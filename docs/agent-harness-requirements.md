# Agent harness requirements

Conveyor runs coding agents through harnesses: Codex and Claude Code today, and later others such
as GitHub Copilot CLI or pi. This page is the shared checklist every harness must meet. A new
harness is not done until it meets every **must**. A change to an existing harness must not break
one.

Each requirement has an ID so issues, reviews and tests can name it. The last section records where
the current harnesses fall short. Keep it current: close a gap there when its fix merges, and add
one when you find one.

## 1. Launch and lifecycle

- **H1.1 Argument arrays.** The harness starts from an argument array, never a shell string. The
  prompt goes in on stdin or a file, never on the command line.
- **H1.2 Bounded run.** Every run has a deadline. On timeout or cancel the harness sends SIGTERM,
  waits `interruptGrace`, then sends SIGKILL, and reports `timeout` or `interrupted`.
- **H1.3 Whole tree stops.** Stopping a run stops every process it started. The agent runs in its
  own PID namespace (`--unshare-pid --die-with-parent`) or its own process group that Conveyor
  kills as a group. Nothing the agent started may outlive the run.
- **H1.4 Exit is classified.** A non-zero exit, a missing or invalid final result, or an invalid
  event stream is a failure with a kind (see section 6), never a success.
- **H1.5 Session resume.** If the harness can resume a session, it records the session id. When a
  question is answered, the same session continues with the answer. It declares this through
  `capabilities.sessionResume`. A harness that cannot resume starts fresh with the question and
  answer in its prompt.
- **H1.6 Headless.** The harness never waits for a terminal, a browser login or an interactive
  approval. Anything that would prompt is either configured away or fails the run.

## 2. Filesystem isolation

- **H2.1 Shared mount plan.** The agent runs inside `agentFilesystemPlan`: an empty root with
  read-only `/usr`, the worktree, the narrow linked-Git paths, its own artifacts, private home and
  scratch, configured writable roots, declared toolchain paths, and resolver and CA files. Nothing
  else from the host is visible.
- **H2.2 Access modes.** `read-only` mounts nothing writable except the run's own artifacts, home
  and scratch. `workspace-write` adds the worktree, its Git administration paths and the
  configured writable roots. Full host access is never the default and never applies without
  confinement.
- **H2.3 Fail closed.** If confinement cannot be set up (no `bwrap`, a namespace refused, a
  toolchain path missing), the run fails before any agent command starts. It never falls back to
  an unconfined launch.
- **H2.4 No nested namespaces.** The design must work on hosts that let `bwrap` create one user
  namespace but forbid creating another inside it (Ubuntu's AppArmor default, the GitHub runners,
  the production host). Never rely on a second `bwrap`, or on the harness's own namespace sandbox,
  inside Conveyor's sandbox. Where the harness has its own sandbox, Conveyor's wrapper is the only
  layer and the harness's is turned off inside it.
- **H2.5 Other runs are invisible.** Other runs' artifacts, private homes and worktrees are never
  mounted, even when they share a parent directory.
- **H2.6 Private temp and home.** `HOME` and `TMPDIR` are per run. Host `/tmp` is never a writable
  root.

## 3. Network isolation

- **H3.1 Egress.** When the repository sets `agentEgress`, the agent runs with `--unshare-net`.
  Commands reach only the allowed hosts through the data-plane proxy. The harness reaches its
  model API through the control-plane proxy, whose token commands never see.
- **H3.2 `network: false` means no network.** Turning off an agent's network must stop its
  commands too, not only hide the harness's web tools.
- **H3.3 Conveyor through the bridge.** With egress, the MCP connection to Conveyor goes through
  the run's Unix socket bridge, never through the host network.

## 4. Credentials and environment

- **H4.1 Sanitized environment.** The agent starts from `sanitizedAgentEnvironment`: an allow-list
  of variables, with provider tokens, `GIT_ASKPASS`, `SSH_AUTH_SOCK`, `GH_CONFIG_DIR`,
  `GIT_CONFIG_GLOBAL`, every `CONVEYOR_*` variable and anything named like a secret removed.
- **H4.2 No source credentials.** The agent never gets a GitHub token or any other source-provider
  credential. It pushes and comments only through Conveyor's tools.
- **H4.3 Harness credentials stay out of reach of commands.** The harness's own credential (an
  OAuth record, an API key) must not be readable by the commands the agent runs: not as a file,
  not in the environment, and not through `/proc/<harness pid>/root` or `/environ`. The target
  design keeps the credential on the host and has a relay add it to the harness's API requests
  (#511).
- **H4.4 Private config copy.** The harness gets a private copy of its configuration and session
  state under the run's home, never the service user's real directory mounted writable. Only
  regular, well-formed files are synced back, never through symlinks.
- **H4.5 Settings are fixed.** User-level settings, hooks, plugins and permission files on the
  host do not apply to the run (Claude Code: `--setting-sources ""`; Codex: explicit `-c`
  overrides).

## 5. Conveyor access and prompting

- **H5.1 Run-scoped MCP only.** The agent reaches Conveyor only through the run's MCP grant
  (`conveyor __mcp --context <file>`). The grant is closed when the run ends. The harness exposes no
  Conveyor tool outside that grant.
- **H5.2 MCP is required.** If the Conveyor MCP server fails to start, the run fails. It never
  continues without Conveyor's tools.
- **H5.3 Tool allow-list.** Built-in tools and extra MCP servers are limited to what the agent's
  configuration grants (`enabledTools`, the web tools only when `network` is on).
- **H5.4 Prompt contract.** The harness passes the assembled prompt unchanged, and the result
  schema through the harness's structured-output option. Tool guidance in the prompt names tools
  the way this harness names them.
- **H5.5 Model and effort.** `model` and `effort` map to the harness's own options. A value the
  harness cannot honour fails configuration loading, not the run.

## 6. Results and failures

- **H6.1 Structured result.** The final result validates against `producerResultSchema` and
  becomes a `RunEnvelope`. A missing or invalid result is a `protocol` failure.
- **H6.2 Failure kinds.** Every failure has one kind: `usage-limit`, `auth`, `process`,
  `protocol`, `timeout` or `interrupted`. Usage limits and authentication failures are
  infrastructure failures, retried with backoff. Detection comes from structured events where the
  harness offers them, and from one shared pattern list otherwise.
- **H6.3 Fallback rules.** Falling back to the next agent follows one documented rule, recorded in
  SPEC, and posts a message in the conversation saying why.
- **H6.4 Usage and cost.** The harness reports input, cached and output tokens. It reports cost
  when the harness gives it, and marks it unavailable otherwise.
- **H6.5 Artifacts survive cleanup.** Declared artifacts are moved out of the private home before
  it is deleted.

## 7. Questions to people

- **H7.1** The agent asks only through `agent.askQuestion` and returns `needs-input`. A
  `needs-input` result without a question is invalid.
- **H7.2** After an answer, the harness resumes the session (H1.5) or starts fresh with the
  question and answer in its prompt. Either way the answer reaches the agent exactly once.

## 8. Observability

- **H8.1 Raw events kept.** Every event line the harness emits is stored as a run event, so
  `conveyor item logs` shows the run and the dashboard knows it is alive.
- **H8.2 Live means running.** A run the dashboard shows as running has a live process behind it.
  A stopped run has a recorded reason.
- **H8.3 Progress for people.** Short progress for people goes through `agent.reportProgress`,
  never the raw event stream.
- **H8.4 Cleanup failures are reported.** A cleanup failure is logged and attached to the result
  without hiding the run's own error.

## 9. Disk and toolchains

- **H9.1 Clean up.** The private home, scratch and private configuration are removed when the run
  ends, and by retention for runs that died.
- **H9.2 Shared caches are bounded.** Caches shared between runs (package caches in writable
  roots) are declared in configuration and have a pruning rule. They must not fill the disk.
- **H9.3 Toolchains are read-only.** Toolchains come in through `agentToolchainPaths`, read-only,
  and never overlap run paths or Conveyor's own files.

## 10. Configuration, doctor and tests

- **H10.1 Config.** The harness has a `runners` entry and agent fields in `src/config/schema.ts`,
  documented in `docs/configuration.md`. A harness-only option is rejected for other harnesses.
- **H10.2 One dispatch point.** The harness registers in the harness registry. Every agent path
  (stage runs, verifier checks, steering) goes through it. No path launches a harness binary
  directly.
- **H10.3 Doctor.** `conveyor doctor` checks the binary, its version, its authentication, and the
  namespaces its launch needs, for every configured harness.
- **H10.4 Tests.** Each harness has, at least:
  - argument tests;
  - real-`bwrap` filesystem tests: a write outside the allowed set fails; another run's files are
    unreadable; the harness credential is unreadable from a command;
  - egress tests;
  - failure-kind tests (usage limit, auth, protocol, timeout, interrupt);
  - resume tests;
  - cleanup tests.

  Real-`bwrap` suites run in CI and are never skipped there (`tests/support/bwrap.ts`).
- **H10.5 Docs.** SPEC §19 and `docs/architecture.md` state, for each harness and launch mode,
  which layer enforces filesystem and network confinement.

## Where the current harnesses fall short

| Requirement | Codex | Claude Code |
| --- | --- | --- |
| H1.2 Bounded run | No deadline is passed on stage runs, verifier checks or steering. | No deadline is passed on stage runs. |
| H1.3 Whole tree stops | `danger-full-access` without egress has no PID namespace. | Met. |
| H2.2 Access modes | `danger-full-access` without egress mounts the whole host (`--dev-bind / /`). | Met: full access is refused. |
| H2.4 No nested namespaces | Codex's own sandbox nests inside Conveyor's (#398, #408). | Met. |
| H3.1, H3.2 Network | Met. | Egress is not supported, and the run fails then falls back to the next agent. Commands always have host network. |
| H4.3 Credentials | The `auth.json` copy is readable by commands (#511). | `CLAUDE_CONFIG_DIR` is mounted writable, and the tokens are in the commands' environment (#511). |
| H4.4 Private config copy | Met. | The real config directory is used (#511). |
| H5.2 MCP is required | Met. | No equivalent of `required`; `startupTimeoutSec` is ignored. |
| H5.4 Tool guidance | Met. | The guidance uses Codex's tool naming. |
| H6.2 Failure kinds | No `auth` kind; the usage-limit patterns differ between runners and the retry policy. | Same. |
| H6.3 Fallback rules | The code falls back on any error, usage limits included, but SPEC says there is no fallback. | Same. |
| H6.4 Usage and cost | Cost is always unavailable. | Cost is always unavailable, even though Claude reports `total_cost_usd`. |
| H6.5 Artifacts survive cleanup | Artifacts declared inside the private home are deleted. | Met. |
| H9.2 Shared caches are bounded | Nothing prunes the shared caches. | Same. |
| H10.2 One dispatch point | Legacy producer, verifier and steering launch Codex directly and skip `toolchainPaths`. | Met. |
| H10.3 Doctor | Met. | No namespace probe for the Claude launch. |
| H10.4 Tests | Met. | No harness-level resume test; no usage-limit test. |
