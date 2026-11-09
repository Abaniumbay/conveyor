---
section: Changed
breaking: true
---
An issue with no Conveyor labels no longer exists for Conveyor, open or closed. When an item loses its `conveyor` label, or is closed without a merged change, Conveyor kills its running agent before making any GitHub request for it, removes its workspace, worktree and branch, and then deletes every database row of the item (issue, stage state, journal, todos, questions, relationships, runs). An interrupted purge finishes after a restart without repeating any workspace removal or GitHub write. The event log keeps the item's events and records `item.purged`. Adding the `conveyor` label back onboards the issue as a new item. The `missing` and `offboarded` projected states are gone, and so is their read-only history card; migration 47 queues existing rows in those states, removes their workspaces and deletes them. Done items keep their labels and stay visible.
