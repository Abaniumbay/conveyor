---
section: Changed
breaking: true
---
Conveyor no longer knows any stage by name; your pipeline configuration alone decides. If you use your own pipeline configuration, check three things:

- **Merge repair routes come from `onFail`.** A changed head, a conflict or an outdated base at merge, and a failed `change.criterionTestsVerified`, now follow the action's `onFail`. Before, they always returned to a stage called `implementation`. Add `onFail: { return: <your build stage> }` to your `change.merge` action, as the packaged pipeline now does. Without it, these failures stop the item as `blocked`.
- **Todos belong to the stage whose agent wrote them.** They are no longer tied to a stage called `implementation`, and are closed out when the item leaves that stage.
- **Stage icons come only from `icon:` in the pipeline.** A stage without one shows no icon.
