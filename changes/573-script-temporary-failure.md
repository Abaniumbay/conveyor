---
section: Added
---

A stage script that exits 75 (EX_TEMPFAIL) or returns `"transient": true` in its JSON result now makes the item wait and run the script again, within `github.outageWaitLimit`, instead of stopping.
