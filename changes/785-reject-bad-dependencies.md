---
section: Changed
breaking: true
---
`item.setDependencies` now refuses the item itself, its children and deeper descendants, its parent and higher ancestors, and any set that would close a dependency cycle. The error names the offending numbers and nothing is written. Order children by setting dependencies on the children, not on the parent. Relations already stored are left as they are. The default refinement instructions state this rule.
