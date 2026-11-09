---
section: Added
---
A configured agent MCP server that exits or does not answer `initialize` at the start of a run is recorded in the run's technical log with its error, and the item's conversation gets one Conveyor note naming it. `conveyor doctor` now starts each agent's MCP servers inside its sandbox and fails when one does not answer.
