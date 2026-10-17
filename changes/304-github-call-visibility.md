---
section: Added
---
`conveyor doctor` shows the last hour of GitHub calls by source (periodic reconcile, webhook, wait,
fallback, agents, commands) with the remaining rate limit, and the service logs the same counts
hourly and warns when less than a fifth of the limit is left. The repository page shows whether its
webhook deliveries are healthy and its GitHub calls of the last hour. Conveyor also asks GitHub to
redeliver webhook deliveries that failed in the last day.
