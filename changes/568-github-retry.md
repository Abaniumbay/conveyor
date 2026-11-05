---
section: Added
---

Temporary GitHub API failures (5xx, GraphQL "something went wrong", truncated JSON, rate limits) are retried with backoff (5s, 15s, 45s, 2m), honouring `retry-after`; permanent errors are still thrown at once.
