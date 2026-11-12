---
section: Changed
breaking: true
---
The first diagnosed required-CI failure no longer re-runs the CI gate in place. It now follows the gate's configured `onFail` route (normally `return: implementation`), so the next attempt receives the failure report as feedback; without a route it uses the default exit-gate failure behaviour. A required-CI failure counts as repeated, and stops the item for intervention, only when the same failure is seen on a different head than the previous failed observation. Observing the same head again never counts as a repeat. If your pipeline relied on the in-place retry, set `onFail` on the CI gate to choose where a first failure goes.
