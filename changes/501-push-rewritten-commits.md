---
section: Fixed
---

An agent can now push a branch it rebased while resolving a conflict. Conveyor previously stopped the item, reporting that the push "would omit published remote commit", even though the rewritten commit still carried that change. A push that really drops a published change is still refused.
