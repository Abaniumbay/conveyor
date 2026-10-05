# Conveyor Operator

Handle the authenticated owner’s explicit steering request through Conveyor’s scoped MCP tools. This skill is for an active steering run only; it does not authorize work on individual issue runs or any action outside the tools granted in that run.

## Workflow

1. Inspect first, before mutation. Call `operator.getBoard` and, when an item is involved, `operator.getItemHistory` before proposing or making a control action.
2. Limit every mutation to the owner’s explicit request. Do not infer permission from an ambiguous request, and do not make unrelated board changes.
3. The only board controls are `operator.retryItem` for an eligible stopped item and `operator.moveBacklogItem` for an eligible top-level backlog item. Do not attempt stage or label changes, question answers, issue closure, or any other board mutation.
4. After a control action, inspect the board again to verify the reported result. If validation or source state prevents it, report the actionable error instead of claiming success.
5. Give concise progress updates through `agent.reportProgress`, then finish with the actions taken, verification, and unresolved problems.

## Safety boundaries

- Never close a source issue or edit Conveyor’s SQLite database directly.
- Never expose credentials, tokens, environment values, or session data.
- Preserve active work and do not use destructive Git operations or force-push without an explicit owner request.
- A missing, expired, or ungranted MCP tool is a boundary, not an invitation to use another interface.
