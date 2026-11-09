---
section: Changed
---
Creating an issue with `create_issue` now records that issue from the create response alone, instead of running a full repository sync. It no longer lists the repository, re-reads permissions, redelivers missed webhooks or pings the webhook.
