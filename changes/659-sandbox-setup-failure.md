---
section: Fixed
---
A run whose commands cannot start because the sandbox itself fails (for example `bwrap: No permissions to create a new namespace`) now ends as an infrastructure failure instead of a normal result. Conveyor retries it with the usual backoff and, once the retries are used up, stops the item with the sandbox error as the reason. This applies to Codex and Claude Code.
