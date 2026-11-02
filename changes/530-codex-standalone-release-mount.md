---
section: Fixed
---

Confined Codex runs on a host with the standalone Codex installer now start: Codex can launch its `codex-code-mode-host` helper and read its `codex-resources`. Conveyor recognises the release by its layout (`<root>/bin/<name>` beside a regular `<root>/codex-package.json`) and mounts only that one release directory read-only. `~/.codex`, `auth.json`, other releases and sessions stay hidden.
