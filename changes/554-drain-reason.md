---
section: Added
---

`conveyor service restart --drain` and `conveyor service stop --drain` take `--reason <text>` (at most 500 characters). The dashboard's drain notice and `conveyor status` show it instead of the generic "service stop or restart", so people watching the board know why work paused.
