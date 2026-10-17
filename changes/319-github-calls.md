---
section: Changed
---
Conveyor reads GitHub only when it needs to. For a repository whose webhook it manages, an item
entering a stage reads its issue once (every step of every item used to re-read the whole
repository), issue and comment deliveries are applied from their payload, finished CI is decided
from check-run deliveries, nothing is read periodically, and a restart reads only the issues changed
while Conveyor was stopped. Webhook health now comes from deliveries: a quiet repository is pinged
after an hour, and only an undelivered ping marks it unhealthy, as an alert that changes no
behaviour. The CI settle window defaults to 30 seconds. `settings.events.reconcileInterval` and
`fullReconcileInterval` are deprecated and have no effect. On the offline benchmark with 30 enrolled
items, a restart goes from 158 GitHub calls to 6, an idle hour from 97 to 4, and one item's
delivery from 243 to 45.
