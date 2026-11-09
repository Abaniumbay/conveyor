---
section: Fixed
---
Items of one repository that start together no longer fail workspace preparation on the shared clone: ref-changing git operations now run one at a time per repository. A workspace preparation failure is retried as an infrastructure error with the usual backoff instead of falling back to the next agent in `with.agents`.
