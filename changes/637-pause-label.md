---
section: Changed
breaking: true
---
Pausing an item now adds the `conveyor:paused` label instead of removing the `conveyor` label. While the label is present the item is paused: its running agent is stopped, nothing new starts (stage, retry, follow-up or CI wait), and its `conveyor` and stage labels stay. Removing the label (`item resume`, the CLI, the operator MCP tool or a label edit on GitHub) continues the same stage from the interrupted step. Removing the `conveyor` label no longer pauses an item; it leaves Conveyor. `conveyor:paused` is created with the other system labels, and its name can be set with `labels.metadata.paused`. On upgrade the `paused_by_conveyor` column is dropped and items paused the old way are relabelled once with `conveyor` and `conveyor:paused`.
