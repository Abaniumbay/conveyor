# Conveyor Release

Cut a release of Conveyor with `bun run release`. A release is published the moment its tag
`vX.Y.Z` is pushed: the Release workflow tests, builds and publishes it, and published releases
cannot be changed. Use this skill only when a person explicitly asked for a release and named, or
agreed to, its version.

## Workflow

1. **Confirm the request.** You need the version (`X.Y.Z`, later than `package.json`'s) and a
   release summary: two to four sentences on what the release is about, for the people installing
   it. Write the summary from the `## [Unreleased]` section of `CHANGELOG.md` and the merged pull
   requests. Do not invent changes that are not there. Show it to the person when you can.
2. **Check the changelog.** Every user-visible change since the last release must be under
   `## [Unreleased]`, with breaking changes marked. If something is missing, add it in a normal pull
   request first; do not put it only in the summary.
3. **Start from a clean, current `main`:** `git switch main && git pull --ff-only`, and
   `git status --short` must be empty.
4. **Open the release pull request:**

   ```sh
   bun run release start X.Y.Z --summary-file <file> --yes
   ```

   It refuses, changing nothing, on a dirty tree, a branch other than `main`, `main` not level with
   `origin/main`, empty Unreleased changes, a version that is not newer, or an existing branch or
   tag. Fix the stated cause. Never bypass the check by editing `package.json` or the changelog by
   hand. Report the pull request URL it prints.
5. **Wait for the merge.** The release pull request goes through review and CI like any other. Do
   not merge it yourself unless the person asked you to.
6. **Tag only after it merged, and only when the person still wants it published:**

   ```sh
   bun run release tag X.Y.Z --yes --watch
   ```

   If it warns that commits were merged after the release commit, they are not in this release; say
   so in your report.
7. **Verify:** `gh release view vX.Y.Z` lists `conveyor-vX.Y.Z-linux-x64.tar.gz`, `install.sh` and
   `checksums.txt`; note whether `linux-arm64` is there, since it is published only when its tests
   pass.

## Safety boundaries

- Never push a `v*` tag by hand, re-tag a published version, or edit or delete a published release
  or its assets. A broken release is fixed by releasing the next patch version.
- Never run `bun run release tag` for a release nobody asked to publish, or before its pull request
  merged.
- If the Release workflow fails, nothing was published. Report the failing job. Delete the tag only
  as `docs/releasing.md` describes, and only when the person agrees.
- Do not change the release workflow, the version rules or the changelog format as part of a release.

## Expected result

Report the version, the release pull request, the tag and the commit it points at, the workflow run
and its outcome, the published assets (and whether arm64 is among them), and anything left
undone.
