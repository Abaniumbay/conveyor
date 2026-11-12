---
section: Fixed
---
Claude Code agents under `agentEgress` can now run commands, hooks and MCP servers: the command prefix runs the one command string Claude Code gives it with `$SHELL -c` instead of treating it as a program name. **Behaviour change:** Conveyor now sets every agent's `SHELL` to bash (an absolute path it resolves) instead of passing on the operator's login shell, so agents behave the same on every host. Bash is a prerequisite and `conveyor doctor` reports it when missing. Before turning on `agentEgress` for Claude Code agents, run `bun scripts/check-agent-egress.ts <repository-id> --config <dir> --runner <runner-id> --live`, which starts the real Claude Code CLI in the run's namespace and fails unless an allowed host is reached and a refused host is refused.
