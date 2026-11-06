---
section: Added
---

An item whose stage fails with a transient GitHub error after the tools' retries now waits ("GitHub unavailable since <time>") and resumes at the same stage once GitHub answers, instead of stopping. After `github.outageWaitLimit` (default `2h`) it goes to `needs-intervention` with a reason naming GitHub and the first failure time.
