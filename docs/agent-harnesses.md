# Agent harnesses

Conveyor calls agents through the `AgentHarness` contract in `src/runner/harness.ts`. A harness provides `runProducer`, `runCheck`, and `runSteering`; the application does not depend on a vendor CLI.

Each call receives a workspace, the already scoped prompt and agent instructions, an access level, one run-scoped MCP launch configuration, optional model and effort hints, a timeout, an abort signal, and an event callback. Producer and verifier results use Conveyor's structured result shapes. Steering returns a summary. Every mode reports a session ID, token usage, duration, exit code, and a cost value; use `{ amount: 0, currency: "USD", source: "unavailable" }` when the harness cannot report cost.

## Registering a harness

Add a runner-specific configuration schema to `src/config/schema.ts`, then register a `HarnessFactory` for its `type` in `AgentHarnessRegistry`. The factory receives the validated runner entry and can capture runner-specific options. Its returned harness must implement all three modes. The application selects the harness from the configured runner entry for agent stages, verifiers, and steering.

Add a harness contract test in `tests/runner/` using a fake process or deterministic fake harness. Cover the three methods, structured results, events, session and usage metadata, and all five `HarnessError` kinds: `usage-limit`, `process`, `protocol`, `timeout`, and `interrupted`. `runWithHarnessRetries` applies the configured usage-limit and infrastructure attempt limits with bounded backoff; interrupted runs stop immediately.

## Scoped MCP and source access

The application creates one MCP launch configuration per run and closes its lease after the harness returns. The launch points to a temporary context containing only that run's grant. Producer and steering grants come from the configured agent tool list; verifier grants are reduced to read and report tools. A harness must launch the supplied MCP server when it needs Conveyor tools and must not receive source credentials or contact GitHub directly.

## Codex example

`defaultHarnessRegistry()` registers Codex. `CodexHarness` in `src/runner/harness.ts` translates neutral access, MCP, model, effort, timeout, and abort inputs into the Codex CLI's sandbox, approval, and `-c model_reasoning_effort` options. The three existing Codex entry points retain Codex JSONL parsing and structured producer/check schemas, while application code uses only the neutral harness contract.

The existing `json-process` runner remains the script-stage runner. It is configured by name under `runners:` and does not implement the agent harness contract.
