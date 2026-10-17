---
section: Fixed
---
An implementation agent's `workspace.fetch` no longer fails before the item's branch is first
pushed (it reports that the branch is not on the remote yet), and a fetch that does fail tells the
agent git's reason instead of only "MCP request failed".
