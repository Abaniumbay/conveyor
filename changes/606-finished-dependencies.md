---
section: Changed
---

A child item can now depend on a sibling that is already finished: `item.createChild` accepts a `dependsOn` naming a closed issue that was completed, and the child starts without waiting. A closed issue that was not finished is refused with a message saying so, and refinement reuses finished children instead of recreating them.
