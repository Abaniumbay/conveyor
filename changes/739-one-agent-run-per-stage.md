---
section: Changed
breaking: true
---
Configuration loading now rejects a stage whose `actions` contain more than one `agent.run`, and `conveyor config check` and `conveyor doctor` report it. A stage is one role: move each further agent into its own stage (route its failures with `onFail`), or list fallbacks as `agents: [a, b]` on a single action. An installation that runs two agents in one stage fails to load until it does.
