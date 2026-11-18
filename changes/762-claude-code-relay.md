---
section: Changed
breaking: true
---
Claude Code runs authenticate through the host credential relay: the run is always sandboxed with `ANTHROPIC_BASE_URL` set to the relay and only a per-run placeholder in `CLAUDE_CODE_OAUTH_TOKEN`. The real token or API key (or the service user's `.credentials.json`) stays on the host, and commands can no longer read the login file from `configDir` or a real credential from the harness's environment.

Operators: a Claude Code agent in a repository without `agentEgress` used to run with the host network. It now runs in an isolated network with an empty host allowlist, so its commands cannot reach the internet. Add an `agentEgress` block with the `httpsHosts` its commands need (package registries, for example) to restore that access.
