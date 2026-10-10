# Contributing to Conveyor

Thanks for your interest in Conveyor. This page covers how to report problems, set up a
development checkout, and what a pull request needs before it can merge.

## Before you start

Conveyor is pre-1.0 and maintained by a small team, so its behaviour and configuration can still
change between minor versions.

- **Bug reports and questions** are welcome as [issues](https://github.com/Abaniumbay/conveyor/issues).
  Include the output of `conveyor --version` and `conveyor doctor`, and what you expected to happen.
- **Small fixes** (a bug with a clear reproduction, a documentation correction) can go straight to a
  pull request.
- **Larger changes** (new features, configuration or pipeline changes, anything touching
  [SPEC.md](SPEC.md)) need an issue first. Agree on the approach there before writing code; a pull
  request that arrives without one may be declined even when the code is good.
- **Security problems** are not for public issues. Report them privately through the repository's
  Security tab.

## Development setup

Conveyor is TypeScript on [Bun](https://bun.sh/) 1.4.

```sh
bun install --frozen-lockfile
bunx playwright install chromium    # once per machine, for dashboard screenshots
bun run check                     # every test and the typecheck
bun run src/cli.ts --help         # the CLI from source
bun run build && bun run smoke    # build the release archive and test it outside the checkout
```

Tests use temporary repositories and databases and need no credentials.

## Pull requests

A pull request is ready when:

1. **`bun run check` passes.** It runs every test and the typecheck, and it is what the Check
   workflow runs on the pull request.
2. **Behaviour changes have tests.** A bug fix comes with a test that fails without it.
3. **The changelog is current.** A change that users can notice adds a line under
   `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) (Added, Changed, Deprecated, Removed or Fixed),
   with breaking changes marked. That section becomes the release notes.
4. **Dashboard layout changes regenerate the screenshots.** Run `bun run docs:screenshots` and
   commit the regenerated images in `docs/screenshots/` in the same pull request. The Check workflow
   regenerates them twice and fails when they differ.
5. **Generated documentation is regenerated.** Run `bun run docs:tasks` after changing a task and
   `bun run docs:cli` after changing a command or its options.
6. **Nothing installation-specific is included:** no real hostnames, repository addresses, logins,
   machine paths or credentials in code, tests, examples or documentation. Use `example.com`,
   `owner/my-app` and similar placeholders.

Keep a pull request to one change, and describe what it changes and why.

## Releases

Maintainers cut releases from tags; see [docs/releasing.md](docs/releasing.md). Contributors do not
need to change the version in `package.json`.

## License

By contributing, you agree that your contribution is licensed under the repository's
[LICENSE](LICENSE).
