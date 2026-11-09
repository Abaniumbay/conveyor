---
section: Fixed
---
Agent runs in a repository with `agentEgress` no longer fail in compiled builds with `unknown command: -e`: the confined egress wrapper starts the network bridge with the executable's own `__bridge` command. The packaged smoke test now runs an agent turn under `agentEgress`.
