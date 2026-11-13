---
section: Changed
breaking: true
---
Every level of the configuration may now hold a `settings` block with the same keys, inherited down to each run: the root `settings`, a repository's, a native stage's, a harness entry's and an agent's. Its first key, `settings.environment`, decides exactly which environment variables an agent run gets: each level's variables, the last definition of a name winning (root, repository, stage, harness, agent), a value as written or, when empty, the service's own value. Conveyor no longer filters variable names, and passes nothing it was not told to.

What operators must check before upgrading:

- **Harness login variables are no longer passed on their own.** Claude Code used to receive `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` from the service's environment. A login stored by the harness's own login command keeps working with nothing to change. If you sign a harness in through a variable, list it in that harness entry's `settings.environment` (an empty value takes the service's); it reaches the harness only, never the commands it runs.
- **An agent's `env` is no longer filtered.** A variable whose name looked like a credential (`*_TOKEN`, `*_SECRET`, `GH_*` and the like) used to be dropped silently; it now reaches the agent. Review your agents' `env` and remove anything the agent should not see.
- **Reserved names are now errors.** `HOME`, `SHELL`, `TMPDIR`, any `CONVEYOR_*` name, and a harness's private directory (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`) may not be set at any level; `configDir` chooses a harness's directory.
- **Proxy variables are passed as written.** The root default includes `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` from the service, now including any credentials in their URLs.

Each agent run also gets `CONVEYOR_RUN_ID`, `CONVEYOR_REPOSITORY_ID`, `CONVEYOR_ITEM_ID`, `CONVEYOR_STAGE_ID` and `CONVEYOR_AGENT_ID`. Claude Code's commands now lose its own variables without `agentEgress` too. Script runs are unchanged for now.
