---
section: Changed
---
A deleted or transferred GitHub issue is purged as soon as Conveyor learns of it, without a sync. An `issues.deleted` or `issues.transferred` delivery kills the item's running agent before any further GitHub request and removes the item. A read of an enrolled issue by number that answers 404 or 410 purges it too, and so does a full listing that omits a stored issue when reading it by number answers 404 or 410. Any other failure (5xx, network) leaves the item unchanged.
