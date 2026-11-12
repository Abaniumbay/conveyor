---
section: Fixed
---
A pull request with a merge conflict no longer waits in the merge stage forever. When GitHub refused the merge, Conveyor checked mergeability against its stored copy of the pull request, which could still say "not computed yet" from before GitHub found the conflict, so it retried every 30 seconds instead of sending the item back to implementation. It now reads the pull request's current state from GitHub before deciding.
