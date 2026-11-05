---
section: Added
---

`conveyor service auto-upgrade install|uninstall|status` opts in to automatic upgrades: a systemd timer periodically runs `conveyor upgrade --latest --if-newer --no-wait`, following every release including minor ones. An unloadable configuration stops the switch. `conveyor status` and `doctor` show an `Auto-upgrade:` line. Turn it off with `uninstall`.
