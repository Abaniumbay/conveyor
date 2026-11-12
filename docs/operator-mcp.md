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
| `item_pause` | Pause an item by adding the `conveyor:paused` label: its running agent is stopped and nothing new starts; its labels, stage, worktree and history are kept. Input: `item`. |
| `item_resume` | Resume a paused item by removing the `conveyor:paused` label. Input: `item`. |
| `question_answer` | Answer an item's open question. Input: `questionId`, `answer`. |
| `list_repositories` | The onboarded repositories. |
| `list_items` | Items with number, title, stage, state and dependencies; optional `repository` filter. |
| `get_item` | One item's details: labels, parent, children, dependencies and criteria. |
| `get_conversation` | An item's shared conversation messages. |
| `get_change_status` | An item's change request, pull request and recorded CI checks. |
| `get_questions_and_runs` | An item's pending questions and run history. |

`item` is `<repository>:<number>` (or `<repository>#<number>`), for example `my-repo:42`. An unknown or
item that left Conveyor is a tool error naming it (`Unknown item: …`). These tools issue the same commands as
the dashboard, through the command bus; they are available only here, not in the REST or control API.

Item tools take `repository` (id or `owner/name`) and `number`. An unknown repository or item is a
tool error naming it.

## Adding a tool

A tool module under `src/operator-mcp/tools/` exports `{ name, description, inputSchema, handler }`
(use `defineOperatorTool`) and is registered with one line in `src/operator-mcp/registry.ts`. The
handler receives `{ input, facade }`: read service state through `facade` and make every change with
`facade.dispatch`, which goes through the command bus. A handler never sees an HTTP request.

## Stop summary

A stop-summary Operator run records a short summary of one item's current stop with the task
`operator.recordStopSummary` (`itemId`, `stopId`, `summary`). The tool is granted only to a run started for
exactly that item and stop: a call naming another item or another stop is refused. A summary is 1 to 600
characters; a longer one is refused. The record is advice only. It never changes the item's stage, state,
labels or recorded stop reason, and gates and routing never read it. It is kept one per item, and
`currentStopSummary(itemId)` returns it only while its stop is the item's current one: after the item
resumes and stops again the read returns nothing until a new summary is recorded. Recording appends the
event `item.stopSummaryRecorded`, which carries the stop id and never the summary text.
