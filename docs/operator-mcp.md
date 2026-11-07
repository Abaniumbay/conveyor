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
| `item_retry` | Retry a blocked or failed item's stopped stage. Input: `item`, optional `note` for the agent. |
| `item_steer` | Send a steering message to the agent running on an item. Input: `item`, `message`. Fails, sending nothing, when no agent is running on it (an idle item or a script stage). |
| `item_pause` | Pause an item; its stage, worktree and history are kept. Input: `item`. |
| `item_resume` | Resume a paused item. Input: `item`. |
| `question_answer` | Answer an item's open question. Input: `questionId`, `answer`. |

`item` is `<repository>:<number>` (or `<repository>#<number>`), for example `my-repo:42`. An unknown or
offboarded item is a tool error naming it (`Unknown item: …`). These tools issue the same commands as
the dashboard, through the command bus; they are available only here, not in the REST or control API.

## Adding a tool

A tool module under `src/operator-mcp/tools/` exports `{ name, description, inputSchema, handler }`
(use `defineOperatorTool`) and is registered with one line in `src/operator-mcp/registry.ts`. The
handler receives `{ input, facade }`: read service state through `facade` and make every change with
`facade.dispatch`, which goes through the command bus. A handler never sees an HTTP request.
