---
section: Changed
breaking: true
---
Conveyor no longer knows any stage by name; your pipeline configuration alone decides. If you use your own pipeline configuration, check three things:

- **Merge repair routes come from `onFail`.** A changed head, a conflict or an outdated base at merge, and a failed `change.criterionTestsVerified`, now follow the action's `onFail`. Before, they always returned to a stage called `implementation`. Add `onFail: { return: <your build stage> }` to your `change.merge` action, as the packaged pipeline now does. Without it, these failures stop the item as `blocked`.
- **Todos follow the tool grants.** Any agent granted the todo tools can keep the list. It is no longer tied to a stage called `implementation`; Conveyor closes out unfinished todos whenever the item moves on to its next stage, and a card shows todo progress while entries are still open.
- **Stage icons come only from `icon:` in the pipeline.** A stage without one shows no icon.
