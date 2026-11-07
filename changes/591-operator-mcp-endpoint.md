---
section: Added
---

Operators can connect an MCP client to the running service. `conveyor mcp token create <name>` prints a bearer token once (only its hash is stored), `conveyor mcp token list` shows tokens without their values, and `conveyor mcp token revoke <id>` makes a token fail with 401 on its next request. The authenticated `/operator-mcp` endpoint serves a `conveyor_status` tool; it is separate from the agents' MCP server and from the dashboard and control API.
