---
section: Changed
---

Egress-wrapped Codex runs now confine filesystem writes: in `workspace-write` only the worktree, its Git administration path, existing configured `writableRoots` and run-private state are writable, and `read-only` grants no writable mount. The namespace root is remounted read-only, which also applies to non-egress Codex and Claude Code runs. A run fails with an actionable infrastructure error before any Codex command starts if the filesystem wrapper cannot be established.
