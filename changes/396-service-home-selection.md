---
section: Fixed
---

Service lifecycle commands now honour `CONVEYOR_HOME` and refuse to operate on a selected systemd unit for a different Conveyor home. Restart output identifies both the unit and home that restarted.
