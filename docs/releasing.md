# Releasing

A release is a Git tag `vX.Y.Z` on a commit whose `package.json` version is `X.Y.Z` and whose
`CHANGELOG.md` has a dated `## [X.Y.Z]` section. Pushing the tag runs
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which publishes the GitHub
release. Nothing else publishes releases.

## Steps

1. Collect changes under `## [Unreleased]` in `CHANGELOG.md` as they merge (Added, Changed,
   Deprecated, Removed, Fixed; mark breaking changes).
2. Prepare the release in a pull request:

   ```sh
   bun run scripts/release.ts prepare 0.2.0
   ```

   This checks that the version is later than the current one, sets it in `package.json`, and moves
   the Unreleased changes into `## [0.2.0] - <today>`. Commit both files, open the pull request and
   merge it once CI passes.
3. Tag the merge commit and push the tag:

   ```sh
   git tag v0.2.0 <merge-commit> && git push origin v0.2.0
   ```

A pre-release tag such as `v0.3.0-rc.1` is published as a GitHub pre-release.

## What the workflow does

1. **Verify:** `scripts/release.ts check <tag>` fails unless the tag, `package.json` and a dated,
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
   - an upgrade to a second build and a rollback, with the script restarting `serve` as systemd
     would.
3. **Publish:** computes `checksums.txt` (SHA-256 of every archive and `install.sh`). It then creates
   the release as a draft with all assets attached, and publishes it.

Assets:

```text
conveyor-vX.Y.Z-linux-x64.tar.gz     executable, LICENSE, THIRD_PARTY_NOTICES.txt, INSTALL.txt
conveyor-vX.Y.Z-linux-arm64.tar.gz   when its tests passed
install.sh
checksums.txt
```

## Repository settings

Enable **immutable releases** in the repository settings (Settings → General → Releases). Once
published, a release's tag and assets can no longer change. The workflow attaches every asset to a
draft before publishing for that reason. Fix a bad release with a new version, never by replacing
assets.

## Building locally

```sh
bun run build                          # dist/conveyor-v<version>-linux-x64.tar.gz, install.sh, checksums.txt
bun run scripts/build.ts --target linux-arm64 --out dist-arm64
bun run scripts/build.ts --out dist-next --version 0.0.0-next
bun run scripts/smoke-test.ts --dist dist --next dist-next   # the work directory must not be under /tmp
```

`--version` overrides the version only for such test builds.
