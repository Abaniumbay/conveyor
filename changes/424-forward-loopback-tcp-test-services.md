---
section: Added
---

Repositories can now declare a loopback TCP test service (`tcp: "127.0.0.1:<port>"`) alongside Unix sockets in `agentEgress.localServices`; only the declared fixed sandbox endpoint reaches it.
