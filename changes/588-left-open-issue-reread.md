---
section: Fixed
---

An item stopped because GitHub left its issue open after the merge now reads the issue fresh from GitHub on every tick, bypassing the cached copy, and resumes as soon as the issue is closed instead of waiting up to an hour.
