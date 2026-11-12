---
section: Fixed
---
`check-agent-egress --live` now runs Claude Code with the runner's sign-in (its `configDir`, else `CLAUDE_CONFIG_DIR`, else `~/.claude`, mounted writable, plus `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`), so it must run as the account the service runs as. A CLI that is not signed in is reported as such, and a missing runner command names the command and the `PATH` searched.
