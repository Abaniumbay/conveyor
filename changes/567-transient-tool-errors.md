---
section: Changed
---

A failing MCP tool call now returns `{ error: "<tool> failed", kind, upstream, status, detail }`, so agents can tell a transient GitHub outage (5xx, GraphQL internal error, push `fatal error`, truncated JSON, 429) from a permanent failure. Agent instructions say not to diagnose transient failures and to stop with "GitHub unavailable".
