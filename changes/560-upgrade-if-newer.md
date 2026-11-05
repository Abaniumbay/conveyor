---
section: Added
---

`conveyor upgrade --latest --if-newer` checks the latest stable release and schedules the drained switch only when it is newer than the running release; otherwise it exits 0 without downloading anything. Combine it with `--no-wait` to run it from a timer or a deploy stage.
