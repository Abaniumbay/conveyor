---
section: Added
---
Every sandboxed run can have a host-side credential relay: a loopback endpoint inside the sandbox that forwards requests over verified TLS to one configured upstream, with the real credential (read on the host for each request) substituted for a random per-run placeholder. It works with or without `agentEgress` and adds no hosts to the egress allowlist.
