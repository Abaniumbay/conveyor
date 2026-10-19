---
section: Added
---

A repository can set `inFlight: { limit, from }` to limit how many of its items are in progress in the code pipeline, counting items waiting for CI or review and not counting refinement. Items over the limit wait in the stage before `from` with the holders named on the dashboard and in `conveyor item show`.
