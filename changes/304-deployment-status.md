---
section: Removed
---
New webhooks no longer subscribe to `deployment_status`, which nothing in Conveyor used; existing
webhooks may keep sending it and those deliveries are recorded and ignored.
