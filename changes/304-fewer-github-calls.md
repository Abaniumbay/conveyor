---
section: Changed
---
Conveyor reads GitHub far less while webhooks deliver. A task waiting for CI or for its blockers
now sleeps until the webhook event it waits for arrives (or its `settings.events.fallback`
deadline passes) instead of re-reading GitHub every minute, and continues within seconds of CI
finishing. Webhook deliveries read GitHub only for the issues they name, CI progress reads nothing,
and while a repository's webhooks are healthy the periodic reconcile becomes a safety net: every
30 minutes (`settings.events.reconcileInterval`) it reads only the issues changed since the last
read, and every 24 hours (`settings.events.fullReconcileInterval`) and at start it reads everything,
including each enrolled item's provenance and author permissions. In a 20-minute CI wait this cuts GitHub calls from 177 to
50; an idle repository goes from 68 calls an hour to 8. Repositories without healthy webhooks keep
polling as before.
