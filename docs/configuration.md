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
