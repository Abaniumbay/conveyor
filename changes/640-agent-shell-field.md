---
section: Added
---
An agent can set `shell: false` (default `true`). A Claude Code agent then runs without `Bash`; on a Codex agent it fails `config check`, because Codex reaches files only through its shell.
