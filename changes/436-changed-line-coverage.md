---
section: Added
---

Pull-request Check runs now reject changes whose newly added production lines are less than 80% exercised. The failure identifies each untested line and its source so the missing test can be added or unnecessary code removed. The browser dashboard application and the repository scripts are not counted: the browser test suites and their own CI steps exercise them.
