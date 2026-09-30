# Provider event contract

Providers authenticate and parse their own webhook deliveries, then hand the engine repository-scoped `ProviderEvent` values. Events identify a configured repository by its repository ID; references are strings so providers can preserve their native issue and change identifiers.

```ts
type ProviderEvent =
  | { type: "issue.changed"; repositoryId: string; issueRef: string }
  | { type: "change.updated"; repositoryId: string; changeRef: string; headSha: string }
  | { type: "ci.updated"; repositoryId: string; commitSha: string }
  | { type: "ci.completed"; repositoryId: string; commitSha: string };
```

`headSha` and `commitSha` are full commit identifiers. The engine ignores events for repository IDs that are not configured. `issue.changed` reconciles that repository and schedules eligible work. `change.updated` prompts the associated pending change to evaluate its current head. A CI event wakes only CI gates parked for the same repository and full commit. Repeated events coalesce while a gate is being evaluated or is already queued.

## Webhook provider responsibilities

Each provider owns its configured endpoint, authentication, delivery deduplication, payload validation, and mapping to the neutral event contract. Invalid authentication must reject the delivery. A valid delivery must be recorded before mapping so unsupported events are deduplicated too. A provider can return no event for unsupported deliveries or malformed identifiers; those deliveries must not affect work.

The GitHub provider uses the configured `webhookPath`, verifies `x-hub-signature-256` with `CONVEYOR_GITHUB_WEBHOOK_SECRET`, and records `x-github-delivery` through the source-event store before processing the payload. It maps:

- completed `workflow_run` and `check_suite` deliveries to `ci.completed`; nonterminal updates with a full SHA map to `ci.updated`;
- `pull_request` `synchronize` deliveries to `change.updated`, using the pull request number and new head SHA;
- `issues`, `issue_comment`, `issue_dependencies`, and `sub_issues` deliveries with an issue reference to `issue.changed`;
- valid but unsupported deliveries to no event.

The GitHub webhook subscription retains its existing events and adds `check_suite` so that completion events from check suites can be routed. Automatic hook configuration continues to use the source's configured webhook path.

## Polling fallback

Webhooks only shorten the wait. The configured CI polling interval remains the fallback for providers without webhooks, missed deliveries, and process restarts. Parked gate state is recoverable from the normal ready stage state, so a restarted service resumes checking CI without a data migration.
