---
section: Added
---

An item whose change merged but whose issue GitHub left open now needs you instead of sitting silently in Cleanup. Ten minutes after the recorded merge (`graceMinutes` on the new `item.issueClosed` check, default 10) the item stops as needs intervention with the merged change number and a plain instruction: close the issue as completed, or reopen the work. The status comment shows the reason as its Blocker, and the dashboard card and Needs you list show it too. Conveyor still never closes the issue itself; once you or GitHub close it, the item resumes and becomes done.
