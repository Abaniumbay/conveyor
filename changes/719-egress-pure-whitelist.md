---
section: Changed
---
Agent egress is now a pure whitelist. Conveyor no longer refuses `api.github.com` and `uploads.github.com` on its own: agents reach a host only when you list it, in a repository's `agentEgress.httpsHosts` for their commands or in a runner's `controlPlaneHosts` for the harness itself, and nothing else. Configurations that worked before reach exactly the same hosts. Leave your code host's API out of the lists to keep agents acting on it only through Conveyor's tools. A pi runner with a GitHub Copilot login can now run under `agentEgress` by listing `api.github.com` and its plan's Copilot host in `controlPlaneHosts`. `scripts/check-agent-egress.ts` now probes a host the configuration does not list (`api.github.com` unless listed, else `example.com`).
