---
section: Fixed
---
A Claude Code harness that authenticates with `claude login` no longer stops delivering once the access token expires. Conveyor now refreshes the login on the host before forwarding a request and writes the renewed login back to the login file in `configDir`; the sandbox still never sees the access or refresh token. When the refresh token is revoked or missing, the run fails with a message to renew the login with `claude login` and is not retried; an unreachable refresh endpoint is retried as a transient failure. `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` are not refreshed.
