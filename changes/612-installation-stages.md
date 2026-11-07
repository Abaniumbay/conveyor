---
section: Added
---

`conveyor.yaml` can now define one installation-wide `stages:` list (inline or `!include builtin:stages.yaml`) that every repository without `pipeline:` follows. A repository skips a stage with `overrides.stages.<stageId>.skip: true`: the stage keeps its place but runs nothing. An override for a stage that is not in the list, or defining both `stages:` and `pipelines:`, is reported by `config check`. `pipelines:` and `pipeline:` keep working unchanged.
