---
section: Added
---

Workspace pushes that GitHub rejects temporarily (for example "fatal error in commit_refs_rules" or "Internal Server Error") are retried with backoff; permanent rejections such as non-fast-forward still fail at once.
