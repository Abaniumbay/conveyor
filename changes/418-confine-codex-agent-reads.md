---
section: Changed
---

Codex and Claude Code agent commands now receive an empty-root filesystem view limited to their run worktree, private run paths, declared writable roots, required Git metadata, and runtime files. This applies with and without configured agent egress, and runs fail before starting an agent when confinement cannot be established.
