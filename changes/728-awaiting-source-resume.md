---
section: Fixed
---
An item whose next stage label was reconciled just before Conveyor committed the advance no longer sits `active` with no run. The periodic reconcile now starts any item waiting for its source whose labels already show its stage, without needing another change at the source.
