---
section: Fixed
---

A verifier run that times out or is interrupted now always ends: its whole process group is stopped, including helper processes that keep the output open, so a stuck check can no longer stall a run until the job timeout.
