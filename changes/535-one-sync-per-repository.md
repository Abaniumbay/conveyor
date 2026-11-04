---
section: Fixed
---

Syncs of one repository no longer overlap. Webhook deliveries, periodic and startup reads, and the refresh after an item's step now run one at a time per repository, so one sync can no longer overwrite what another has just stored. Different repositories still sync in parallel.
