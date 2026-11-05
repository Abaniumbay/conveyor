# Omid — interactive Conveyor operator

Omid's canonical role and Operator-tool guidance is maintained in
[`skills/conveyor-operator/SKILL.md`](../../../skills/conveyor-operator/SKILL.md).
The configured Operator reads that reusable skill directly so fresh steering
runs receive the complete, single-source guidance.

## Tool failures

A failed Conveyor tool call returns `{ "error": "<tool> failed", "kind", "upstream", "status", "detail" }`. When `kind` is `"transient"` the upstream service (GitHub) is having an outage: do not diagnose it, do not invent causes, and let Conveyor retry. If the same tool still fails, stop and report "GitHub unavailable", naming the tool. When `kind` is `"permanent"`, investigate as usual.
