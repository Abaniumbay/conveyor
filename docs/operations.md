# Installing and operating Conveyor

This guide takes a Linux machine from nothing to a running Conveyor service, and covers day-to-day
operation, troubleshooting and upgrades. Every command is in the [command reference](cli.md), and
the configuration is described in [configuration.md](configuration.md).

Three locations stay independent:

1. **The installed executable:** `<prefix>/versions/<version>/conveyor`, with
   `<prefix>/current` pointing at the release that runs, and `conveyor` on `PATH` linked to it.
2. **The Conveyor home** (default `~/.conveyor`): configuration, credentials, state, logs,
   artifacts and worktrees.
3. **The managed repositories:** existing Git checkouts (for example `~/codes/<repo>`) that the
   configuration points at.

Upgrades replace only the first. Uninstalling keeps the second and third.

```text
~/.conveyor/
├── config/            conveyor.yaml and included files; may be your private configuration repository
│   ├── conveyor.yaml
│   ├── secrets.yaml   git-ignored, referenced with !secret
│   └── repositories/  one file per repository
├── state/             conveyor.sqlite, session-secret, releases.json, builtin/
├── logs/              conveyor.log (rotated)
├── artifacts/         per-run artifacts
├── worktrees/         per-item Git worktrees
├── backups/           state saved before each upgrade
└── run/               control.sock (the CLI's connection to the running service)
```

## Requirements

- Linux on x64 or arm64 with glibc (Alpine and other musl systems are not supported).
- Git, and the [GitHub CLI](https://cli.github.com/) authenticated for the managed repositories.
- `bwrap` (bubblewrap), with unprivileged user namespaces allowed, for agent isolation.
- The agent CLIs your configuration uses (Codex, Claude Code), each signed in.
- Whatever the managed repositories need to build and test.
- Bun only if your operator scripts are TypeScript or JavaScript run without an `interpreter`.
  Conveyor itself does not need it.

Run Conveyor under a non-root account. Use a dedicated one, or your own, as long as it owns the
home and the install prefix and holds the GitHub and agent sign-ins.

## 1. Install

As the account that will run Conveyor:

```sh
curl -fsSLO https://github.com/Abaniumbay/conveyor/releases/download/v0.2.0/install.sh
sh install.sh --version v0.2.0        # omit --version for the latest release
conveyor --version
```

`install.sh` picks the archive for this CPU and verifies its SHA-256 against the release's
`checksums.txt`. It installs into `~/.local/share/conveyor/versions/<version>` and links
`~/.local/bin/conveyor` (as root: `/opt/conveyor` and `/usr/local/bin`; choose with `--prefix` and
`--bin-dir`). For an offline machine, download the archive, `checksums.txt` and `install.sh`
elsewhere, then run `sh install.sh --archive <file> --checksums checksums.txt`.

## 2. Create the home and the first administrator

```sh
conveyor init
```

`init` creates `~/.conveyor`. It writes a starter `conveyor.yaml` that includes the packaged
defaults, an empty `secrets.yaml` (mode 0600) and a `.gitignore` entry for it, and asks for the
dashboard administrator's username and password (the password is not echoed). There is no default
password. Without a terminal, pass both:

```sh
conveyor init --admin-username admin --admin-password-file /run/secrets/conveyor-admin   # or - for stdin
```

`init` is safe to repeat. It never replaces a file and creates the administrator only while no
account exists.

**Private configuration repository:** to keep the configuration in Git, clone it to
`~/.conveyor/config` before running `init`; `init` then keeps its files and only adds what is
missing. Commit everything except `secrets.yaml`. Configuration changes and application upgrades
are separate: pull configuration changes with Git, then restart (`conveyor service restart
--drain`).

## 3. Add repositories

Each managed repository is one file in `config/repositories/`, named by its id. The repository
folder must be an existing clone:

```yaml
# ~/.conveyor/config/repositories/meal-planner.yaml
items: github
code: github
ci: { provider: actions, mode: required }
address: owner/meal-planner
folder: ~/codes/meal-planner
pipeline: delivery
agentEgress: { allowLoopbackMcp: true, httpsHosts: [registry.npmjs.org] }
overrides:
  stages:
    deploy:
      actions:
        deployScript: { with: { script: ../stages/deploy-meal-planner.ts, recovery: reconcile } }
```

## 4. Authenticate and check

As the same account:

```sh
gh auth login
codex login          # or: claude, for Claude Code agents
conveyor doctor
conveyor config check
```

`doctor` checks the home and the configuration. It also checks Git, the GitHub CLI's
authentication, bubblewrap namespaces, every harness and script interpreter the configuration uses,
each repository checkout, the dashboard account and the listen port. Each failure comes with the
fix. Agent sign-ins are separate from the dashboard administrator.

## 5. First run

```sh
conveyor serve
```

This runs in the foreground, logging to the terminal and to `~/.conveyor/logs/conveyor.log`. Open the
dashboard at the printed address (`http://127.0.0.1:7788` by default; put a reverse proxy with HTTPS
in front for remote access, and set `web.publicUrl`). Stop it with Ctrl-C.

## 6. Run it as a service

```sh
sudo conveyor service install --account "$USER"
sudo conveyor service start
conveyor status
```

`service install` writes `/etc/systemd/system/conveyor.service` and enables it. It runs
`<prefix>/current/conveyor serve` as the account, with the home, configuration, `HOME` and `PATH`
recorded in the unit, so nothing depends on a shell's directory or environment. The home and the
install prefix must belong to the account; `install` says which `chown` to run if not. If the agent
CLIs are not in `~/.local/bin`, `~/.bun/bin` or the system directories, pass `--path`.

| Command | Effect |
| --- | --- |
| `sudo conveyor service start` | Starts the service and waits until it answers. |
| `sudo conveyor service stop --drain` | Stops admitting work, waits for running work (`--timeout`, default 30m), then stops. Without `--drain`, running agent work is interrupted and resumes after the next start. |
| `conveyor service restart --drain` | Drains, then the service exits and systemd starts it again. Needs no `sudo`. |
| `conveyor service status` | The unit's state and the running service. |
| `sudo conveyor service uninstall` | Removes the unit. The home and installed releases are kept; delete them yourself only if you no longer need them. |

When a drain times out, nothing is stopped and admission resumes; `--force` goes ahead anyway.

`GET /health/live` is public, for process supervision and load balancers. Readiness, operational
data and the dashboard require a signed-in account.

## Day to day

```sh
conveyor status                       # versions, paths, dashboard URL, health, capacity, stopped items, disk use
conveyor board                        # every item with its stage and state
conveyor item show conveyor:90        # its stage, the concrete blocker, and the recovery actions that apply
conveyor item history conveyor:90     # stage transitions
conveyor item logs conveyor:90 --follow   # agent events, tool calls and checks
conveyor item retry conveyor:90 --note "rotated the key"
conveyor item pause conveyor:90       # removes its enrollment label; resume restores it
conveyor questions list
conveyor questions answer <id> <answer>
conveyor logs --level warn --since 1h --follow
```

These commands talk to the running service through `~/.conveyor/run/control.sock`. Only the service
account (and root) can open it, and the commands use the same operations, with the same checks, as
the dashboard. Under `sudo`, the `service`, `upgrade` and `rollback` commands find the home through
the installed unit; for other commands, run them as the account (`sudo -u <account> conveyor
status`) or pass `--home`. Add `--json` for scripts. Exit code 4 means the service is not running,
and 5 means it refused the request (the reason is printed).

## Logs and disk use

- **Service logs:** startup, shutdown, configuration problems, scheduling, and provider and
  infrastructure errors. They go to the journal (`journalctl -u conveyor`) and to
  `~/.conveyor/logs/conveyor.log`, rotated by `settings.logging`. Records carry the repository, item,
  stage and run they concern. Credentials and tokens are redacted.
- **Run history:** agent transcripts, tool calls and checks. It is stored in the database and per-run
  artifacts, and shown by `conveyor item logs`. It is pruned only by `settings.retention` or
  `conveyor cleanup`, and only for items that are closed, done or offboarded.
- `conveyor status` shows the disk use of state, logs, artifacts, worktrees and backups.

## Troubleshooting

- `conveyor doctor` first: it names each missing prerequisite with its fix.
- `conveyor item show <item>` explains why an item stopped and what can be done. Service-level
  failures (provider outages, crashes) appear in `conveyor logs --level warn`.
- The service does not start: check `conveyor service status` and `journalctl -u conveyor -n 100`.
  "another Conveyor is already running for this home" means a second instance (for example a
  foreground `serve`) holds the control socket.
- "the database schema (N) is newer than this Conveyor supports" means a newer release migrated the
  database: upgrade again, or `conveyor rollback --restore-backup`.
- `conveyor admin reset-password <user>` sets a dashboard password from the command line and signs
  out that account's sessions. It works with the service stopped too.
- `conveyor diagnostics export` writes a tarball for a bug report: version, doctor, the redacted
  configuration, status and service logs. It never includes the database or credentials, and its
  manifest lists what each file holds (it may contain issue titles, repository details and stop
  reasons). Review it before sharing.

## Upgrades and rollback

```sh
conveyor upgrade --version v0.3.0     # sudo works too
```

The steps:

1. Download the release and verify its checksum.
2. Install it beside the current one.
3. Validate your configuration with it; nothing switches if that fails.
4. Ask the service to stop admitting work and wait for running work (`--drain-timeout`, default 30m;
   on timeout the upgrade is cancelled and work resumes).
5. Back up the database and session secret to `~/.conveyor/backups/`.
6. Point `<prefix>/current` at the new release and restart.
7. Wait until the new release reports ready.

It never changes your configuration or credentials. With the service stopped, `upgrade` backs up and
switches directly. There is no automatic upgrade.

```sh
conveyor rollback                     # back to the release the last upgrade replaced
conveyor rollback --restore-backup    # also restore the database saved before that upgrade
```

If the newer release migrated the database, plain `rollback` refuses: the older release cannot run
on the newer schema. `--restore-backup` restores the pre-upgrade backup, which loses what was
recorded since the upgrade. The newest five backups are kept.

**Conveyor delivering itself.** A deploy stage that upgrades the running Conveyor must not wait for
the drain, because the drain would wait for that very stage. Its script runs
`conveyor upgrade --version <tag> --no-wait`. That returns once the service has scheduled the
upgrade, so the stage completes and the engine records the boundary. The service switches when
nothing runs, and after the restart the item continues at its next stage (for example `verify`).
For this, the install prefix must belong to the service account, which `service install` already
requires.

## Running several instances

Several Conveyors can run on one machine, each completely separate. An instance is its own home:
configuration, database, logs, worktrees, artifacts, backups and control socket all live under it.
Give each instance:

| Per instance | How |
| --- | --- |
| A home | `--home <dir>` (or `CONVEYOR_HOME`) on every command |
| A dashboard port, and public URL if any | `web.listen` and `web.publicUrl` in its `conveyor.yaml` |
| A systemd unit | `service install --unit <name>`, and `--unit <name>` on the other `service` commands |
| An install prefix, to upgrade it on its own | `install.sh --prefix <dir> --bin-dir <dir>` |
| Optionally, its own Unix account | separate `gh`, Codex and Claude sign-ins and quotas |

Two rules matter:

- **A repository belongs to exactly one instance.** Two instances managing the same repository act
  on the same issues, labels and branches.
- **`upgrade` switches `<prefix>/current` for every instance that shares that prefix.** Give each
  instance its own prefix, or upgrade all instances of a shared prefix together.

A second instance `b` beside the first, under the same account:

```sh
sh install.sh --version v0.2.0 --prefix ~/.local/share/conveyor-b --bin-dir ~/.local/bin-b
alias conveyor-b="$HOME/.local/bin-b/conveyor --home $HOME/.conveyor-b"
conveyor-b init                       # then set web.listen to another port, e.g. 127.0.0.1:7789
conveyor-b doctor
sudo ~/.local/bin-b/conveyor service install --unit conveyor-b --account "$USER" --home ~/.conveyor-b --path "$PATH"
sudo ~/.local/bin-b/conveyor service start --unit conveyor-b
conveyor-b status
```

Commands without `--home` use `~/.conveyor`, and `service` commands without `--unit` act on
`conveyor.service`, so name the instance every time.

## Moving an existing installation

A source checkout run with `bun run src/cli.ts serve --config <directory>` moves to a release as
described in [migration.md](migration.md#moving-to-a-release-installation).
