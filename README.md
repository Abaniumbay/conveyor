# Conveyor

Conveyor is a lightweight, always-on delivery orchestrator for one trusted VPS. GitHub remains the source of truth: issues enter through labels, configurable agents and scripts move them through a pipeline, and every visible status is projected back from GitHub.

The engine is a single Bun process backed by SQLite. It uses existing repository checkouts plus Git worktrees, invokes installed Codex CLI agents, exposes a run-scoped MCP server, and serves a small authenticated Preact control plane. Preact is rendered on the server; a small dependency-free browser script adds live refresh, dialogs, and streaming output without a hydration runtime.

## Current scope

- Split YAML configuration outside managed repositories
- GitHub polling and signed webhooks
- Configurable stages, enter/exit verifiers, scripts, source actions, and per-agent MCP tool grants
- Codex and strict JSON-process runners
- Per-stage, per-repository, and global concurrency
- Durable issue, run, cost, question, mutation, and transition state in SQLite
- Parent/child and dependency primitives
- Safe worktree isolation without containers
- Structured questions, backlog ordering, issue details, live refresh, and a responsive server-rendered Preact dashboard
- An optional configured Codex steering agent with persisted live progress and final reports
- A single-row Kanban ordered as Backlog → configured stages → Done, plus a separate label-attention view
- Idempotent PR creation and squash merge
- Explicit cleanup as a configured stage

Conveyor never changes an issue's open/closed state. See [SPEC.md](./SPEC.md) for the complete behavioral contract.

## Requirements

- Bun 1.4 or newer
- Git and GitHub CLI (`gh`) authenticated for configured repositories
- Codex CLI for Codex-backed agents
- Existing local checkouts; v0.1 does not clone repositories

## Development

```sh
bun install --frozen-lockfile
bun run check
```

Configuration is intentionally machine state and should live outside this repository:

```sh
bun run src/cli.ts check-config --config /etc/conveyor
bun run src/cli.ts hash-password --password 'choose-a-password'
bun run src/cli.ts serve --config /etc/conveyor
```

The dashboard is server-rendered with a small dependency-free browser script for live refresh, issue dialogs, and steering output. The service requires these environment variables:

- `CONVEYOR_USERNAME`
- `CONVEYOR_PASSWORD_HASH`
- `CONVEYOR_SESSION_SECRET`
- `CONVEYOR_GITHUB_WEBHOOK_SECRET` when webhook installation is enabled

`GET /health/live` is public. The dashboard and readiness endpoint require login. Webhook payloads are HMAC-verified, and MCP access tokens are scoped to one live run and removed when it ends.

## Enrollment

An issue is enrolled by adding the base `conveyor` label. Any `conveyor:*` label keeps it visible, but removing the base label pauses execution. Removing every Conveyor label makes it invisible and stops all issue-specific source actions. Conveyor only creates configured labels during repository onboarding; it does not enroll existing issues automatically.
