---
section: Added
---
`item.dependenciesMet` accepts `with: { after: <stage> }`: a blocker counts as resolved once it has moved past that stage of its own pipeline, so dependents can start when a blocker has merged instead of waiting for it to be done. Without `after`, a blocker still counts only when closed or done. A blocker whose pipeline has no such stage counts only when closed or done, and the scheduler applies the same threshold.
