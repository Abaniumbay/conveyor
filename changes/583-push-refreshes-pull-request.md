---
section: Fixed
---

A lost pull request webhook no longer blocks an item after a push: Conveyor now forgets its cached copy of the pull request when it pushes a branch, and re-reads it when a pushed head does not match, instead of waiting up to an hour for the cache to expire.
