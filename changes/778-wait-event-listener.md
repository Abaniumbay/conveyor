---
section: Added
---
While a CI or change wait of a repository is pending, Conveyor now runs one `gh event listen` process for it, so a completed check suite, a pull request review, a merge conflict or a new head wakes the wait at once instead of at its next poll. This needs no public URL, and the woken task still reads GitHub again, so its outcome is the one a poll gives. If `gh` is missing, too old or not logged in, or the listener exits, Conveyor logs one warning per failure, the waits keep polling at their interval, and the listener restarts with a backoff while a wait is pending.
