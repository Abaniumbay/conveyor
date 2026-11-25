---
section: Changed
breaking: true
---
A child's dependencies are now only the ones it declares. The operator MCP `get_item` no longer returns `inheritedDependencies`, and the board and item details no longer list inherited dependencies. Instead the scheduler does not start an item while any ancestor has an unmet dependency, and a held-back item shows a status line naming the nearest waiting ancestor, for example "Waiting: parent #12 is blocked by #9" (`get_item` returns it as `waiting`). Relations already stored are left as they are.
