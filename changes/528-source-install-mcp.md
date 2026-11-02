---
section: Fixed
---

Confined agents on an instance run from a source checkout (`bun run src/cli.ts serve`) can start their run-scoped MCP server again. The checkout's `src/`, `package.json` and `node_modules` are mounted read-only into the sandbox; the rest of the checkout, the service home and configuration stay hidden. Compiled releases are unchanged.
