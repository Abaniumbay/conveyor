---
section: Added
---

Stored webhook payloads are now deleted after `settings.retention.webhookDeliveries` (default `7d`, minimum 24 hours). Before, every delivery was kept forever and could take a large share of the database. The daily retention pass and `conveyor cleanup` delete older deliveries in small batches; `conveyor cleanup --dry-run` reports how many it would delete.
