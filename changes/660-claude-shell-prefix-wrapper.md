---
section: Fixed
---
Claude Code agents can run shell commands in repositories with `agentEgress`. The command prefix is now one per-run wrapper script instead of a space-joined command line that Claude Code could not execute. `scripts/check-agent-egress.ts` now invokes the prefix the way Claude Code does and accepts `--home` to load configurations that use `builtin:` includes.
