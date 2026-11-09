---
section: Fixed
---
Removing a workspace and the sweep of orphaned scratch directories now delete a scratch directory even when it holds read-only directories, such as Go module caches. Cleanup no longer stops after repeated permission errors.
