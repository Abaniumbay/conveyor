---
section: Changed
breaking: true
---
`agent.run` with `with.agents` now falls back to the next agent only when the first agent's harness cannot run: a usage limit, a process that fails or cannot start, or a missing CLI. Workspace, MCP, protocol and timeout errors no longer fall back; they end the attempt as an infrastructure error retried with the executor's backoff. An invalid structured result is returned once to the same agent, in the same session, with the validation message; a second invalid result is an infrastructure error. Configurations that relied on a backup agent for those failures must now handle them through the retry.
