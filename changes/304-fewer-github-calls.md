---
section: Changed
---
Conveyor reads GitHub far less while webhooks deliver. A task waiting for CI or for its blockers
now sleeps until the webhook event it waits for arrives (or its `settings.events.fallback`
deadline passes) instead of re-reading GitHub every minute, and continues within seconds of CI
finishing. Webhook deliveries read GitHub only for the issues they name, CI progress reads nothing,
and the periodic reconcile becomes a safety net every 30 minutes (`settings.events.reconcileInterval`)
while a repository's webhooks are healthy. In a 20-minute CI wait this cuts GitHub calls from 177 to
50; an idle repository goes from 68 calls an hour to 13. Repositories without healthy webhooks keep
polling as before.
