---
section: Changed
breaking: true
---
Webhook deliveries are now read by the provider's own plugin and recorded as provider-neutral events, so a second item source, code host or CI system can report the same events. The GitHub-named events are replaced:

| Before | Now |
| --- | --- |
| `github.issueUpdated` | `itemSource.itemChanged` (adds `item` and `actors`: the issue as the delivery describes it and who changed it) |
| `github.relationshipChanged` | `itemSource.relationsChanged` |
| `github.ping` | `itemSource.pinged` |
| `github.changeUpdated` | `code.changeUpdated` |
| `github.ciUpdated` | `ci.runUpdated` (`pullRequests` is now `changes`) |

Every one of them is an `ingest` event whose `source` is `github`. `itemSource.itemChanged` may carry the issue's title and body, so event sinks receive it only with `includeContent: true`. **What to change:** an event sink, script or `conveyor events --type` filter that matched the `github.*` names must use the new names, and a sink that needs `itemSource.itemChanged` must set `includeContent: true`. The webhook endpoint, its secrets and GitHub's webhook settings are unchanged; a refused delivery for another provider's repository now says "invalid webhook signature for this repository".
