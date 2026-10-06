# Releasing

A release is a Git tag `vX.Y.Z` on the commit whose `package.json` version is `X.Y.Z` and whose
`CHANGELOG.md` has a dated `## [X.Y.Z]` section. Pushing the tag runs
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which tests, builds and publishes
the GitHub release. `bun run release` walks you through both halves; nothing else publishes
releases.

## Before the first release

Enable **immutable releases** in the repository settings: Settings → General → Releases → enable
release immutability. Once published, a release's tag and assets can no longer change. The workflow
attaches every asset to a draft before publishing for that reason.

## Every release

### 0. Keep the changelog current

Every pull request that changes behaviour adds a line under `## [Unreleased]` in `CHANGELOG.md`
(Added, Changed, Deprecated, Removed, Fixed; mark breaking changes). That section becomes the
release notes, so what is not there is not announced.

### 1. Start the release

On an up-to-date `main` with a clean working tree:

```sh
git switch main && git pull --ff-only
bun run release start
```

It checks that `gh` is signed in and that `main` is clean and level with `origin/main`. Then it:

1. Asks for the version, suggesting the next patch, minor and major versions. It must be later than
   the current one.
2. Shows the Unreleased changes and asks for a **release summary**: a few sentences on what the
   release is about. Finish it with an empty line. The summary opens the release notes.
3. Shows the complete release notes and asks for confirmation.
4. Creates `release/vX.Y.Z`, sets the version in `package.json`, and moves the Unreleased changes
   into `## [X.Y.Z] - <today>` under your summary.
5. Commits as `chore(release): vX.Y.Z`, pushes, and opens the pull request "Release vX.Y.Z" with the
   notes.

Nothing is changed if you decline or anything fails before that.

### 2. Merge the release pull request

Review the notes in the pull request (edit `CHANGELOG.md` on the branch if needed) and merge it once
CI passes.

### 3. Tag it

```sh
bun run release tag X.Y.Z            # add --watch to follow the Release workflow until it publishes
```

It fetches `origin/main` and finds the commit that set the version, which is the release commit. It
verifies that `package.json` and the changelog agree there, shows the notes, warns about commits
merged after the release commit (they are not part of the release), asks for confirmation, then
creates and pushes the annotated tag `vX.Y.Z`. **Pushing the tag publishes the release.**

### 4. Check it

```sh
gh release view vX.Y.Z
```

The release has `conveyor-vX.Y.Z-linux-x64.tar.gz` and, when its tests passed,
`conveyor-vX.Y.Z-linux-arm64.tar.gz`, plus `install.sh` and `checksums.txt`. Installations upgrade
with `conveyor upgrade --version vX.Y.Z`.

## What the workflow does

1. **Verify:** `bun run release check <tag>` fails unless the tag, `package.json` and a dated,
   non-empty changelog section agree. That section becomes the release notes. The job then runs every
   test and the typecheck.
2. **Build and smoke-test** each target on its own architecture: `linux-x64` on `ubuntu-latest`
   (required) and `linux-arm64` on `ubuntu-24.04-arm`. The arm64 target is published only if its
   job passes. Each archive is installed with `install.sh` outside the checkout, without Bun, and
   exercised by `scripts/smoke-test.ts`:
   - `init`, configuration with the packaged pipeline, and `doctor`;
   - the sandbox bridge, the dashboard with its embedded assets, and sign-in;
   - an agent run whose harness drives the packaged MCP server;
   - `status` and `logs`;
   - an upgrade to a second build and a rollback, restarting like systemd would.
3. **Publish:** computes `checksums.txt` (SHA-256 of every archive and `install.sh`), creates the
   release as a draft with all assets, and publishes it. A tag with a pre-release suffix (`v0.3.0-rc.1`)
   becomes a GitHub pre-release.

## When something goes wrong

- **`start` refuses:** read the message. It names the problem: a dirty tree, not on `main`, `main`
  behind `origin/main`, no Unreleased changes, a version that is not newer, or a branch or tag that
  already exists.
- **The Release workflow failed:** nothing was published. Fix the cause on `main` (a normal pull
  request), delete the tag, and tag again:

  ```sh
  git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z
  bun run release tag X.Y.Z
  ```

  If the fix changed the release itself, `tag` still tags the release commit; to include the fix,
  release the next patch version instead.
- **A published release is broken:** published releases are immutable. Release a fixed version
  (`X.Y.Z+1`); installations upgrade to it, or `conveyor rollback`.

## For agents

Agents release with the same commands, non-interactively, and only when a person asked for that
release. See [skills/conveyor-release/SKILL.md](../skills/conveyor-release/SKILL.md).

```sh
bun run release start 0.3.0 --summary-file notes.md --yes   # or --summary "<text>"; - reads stdin
bun run release tag 0.3.0 --yes --watch                     # only after the release pull request merged
```

Without a terminal, `start` needs the version, `--summary` or `--summary-file`, and `--yes`; `tag`
needs `--yes`. Missing ones are refused rather than guessed.

## Building locally

```sh
bun run build                          # dist/conveyor-v<version>-linux-x64.tar.gz, install.sh, checksums.txt
bun run scripts/build.ts --target linux-arm64 --out dist-arm64
bun run scripts/build.ts --out dist-next --version 0.0.0-next
bun run scripts/smoke-test.ts --dist dist --next dist-next   # the work directory must not be under /tmp
```

`--version` overrides the version only for such test builds. `bun run release prepare <version>`
does the version and changelog step alone, without Git, for experiments.
