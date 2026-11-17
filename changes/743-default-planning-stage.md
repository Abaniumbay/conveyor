---
section: Changed
---
The packaged stages now run a `planning` stage between work breakdown and implementation. Its packaged agent `tara` records the test plan, the `item.testPlanComplete` gate checks it, and the packaged implementer and reviewer instructions work from that plan. Installations that use the packaged stages gain the stage on upgrade; installations with their own stages are unchanged until they add one.
