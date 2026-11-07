# Operator MCP endpoint

The running service exposes an MCP server for operators at `/operator-mcp` on the dashboard address
(streamable HTTP, stateless). It is separate from the per-run MCP server agents use
(`/internal/mcp`), which stays unreachable from this endpoint and the other way round. No dashboard
or control API route dispatches an operator tool.

## Tokens

Every request needs `Authorization: Bearer <token>`. A missing, unknown, malformed or revoked token
gets `401` and runs no tool.

```sh
conveyor mcp token create laptop    # prints the token once; only its SHA-256 hash is stored
conveyor mcp token list             # name, id, creation time, revoked state; never a token value
conveyor mcp token revoke <id>      # the token's next request fails with 401
```

The commands read and write the database directly, so they work whether or not the service is
running. Put the dashboard behind HTTPS before sending a token over a network.

## Tools

| Tool | Description |
| --- | --- |
| `conveyor_status` | The service status, as `conveyor status` reports it. |

## Adding a tool

A tool module under `src/operator-mcp/tools/` exports `{ name, description, inputSchema, handler }`
(use `defineOperatorTool`) and is registered with one line in `src/operator-mcp/registry.ts`. The
handler receives `{ input, facade }`: read service state through `facade` and make every change with
`facade.dispatch`, which goes through the command bus. A handler never sees an HTTP request.
