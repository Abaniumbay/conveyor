---
section: Fixed
---

Confined Codex and Claude Code agents get a private, writable `/tmp` again. Since v0.16.0 they had none, so tools that use `/tmp` directly (such as `dotnet test`, `msbuild` and installer scripts) failed inside agent runs. Each run's `/tmp` is its own scratch directory: the host `/tmp` and other runs stay invisible, and it is removed with the run. Read-only agents get one too, without write access to their worktree.
