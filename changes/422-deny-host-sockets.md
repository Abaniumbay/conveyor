---
section: Fixed
---

Egress-sandboxed agent commands now deny host path-based Unix sockets by default, including Docker. Only the run's explicitly forwarded proxy and MCP sockets remain available through the sandbox bridge.
