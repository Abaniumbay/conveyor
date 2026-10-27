---
section: Fixed
---

An item whose pull request Conveyor merged no longer gets stuck before verify when GitHub's merge notification arrives while the merge stage is still finishing. Previously the item sat in its next stage with no run, no blocker and no retry action.
