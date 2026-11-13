---
section: Changed
breaking: true
---
Each agent harness now inherits only its own variables from the service: Claude Code agents no longer receive the service's `CODEX_HOME`. Codex agents get the same environment, private Codex home, mounts and network policy as before. `conveyor doctor` now checks the bubblewrap namespaces and mounts that `agentEgress` needs whenever any agent runs on a harness, Claude Code included, not only when a Codex agent is configured, and the checks are renamed from `Codex egress namespaces` and `Codex egress mounts` to `Agent sandbox namespaces` and `Agent sandbox mounts` (their details now say "agent egress isolation"). **What to change:** a script that reads `conveyor doctor` output (for example `--json`) and matches the old check names must match the new ones.
