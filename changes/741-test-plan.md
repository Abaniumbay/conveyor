---
section: Added
---
Planning agents can record a test plan on an item with `item.setTestPlan`: numbered cases per acceptance criterion (`AC-n.m`, each with what it proves, the boundary, setup, action, expected outcome and kind) and constraints (`mustNotTouch`, `reuse`, `redLines`). The plan is kept in a managed Test Plan section of the issue body, `item.get` and the agent handover return it as `testPlan`, and the new `item.testPlanComplete` gate passes when every non-manual criterion has a planned case and the criteria have not changed since the plan was recorded.
